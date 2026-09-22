import { createHash } from "node:crypto";
import type { ExecutionState } from "@agent-platform/contracts";
import type {
  EnsureExecutionResult,
  ExecutionBackend,
  ExecutionBackendCapabilities,
  ExecutionObservation,
  ExecutionRef,
  LaunchIntent,
  ManagedExecution,
  TerminateExecutionResult,
} from "@agent-platform/platform";
import {
  type LocalDockerBackendConfig,
  validateLocalDockerConfig,
} from "./config.ts";
import {
  type ContainerCreateBody,
  type ContainerInspect,
  DockerApiError,
  DockerClient,
} from "./docker-client.ts";

export const LABELS = {
  executionId: "agent-platform.session-execution-id",
  generation: "agent-platform.generation",
  /** Which isolation contract the container was created under. */
  isolation: "agent-platform.isolation",
  /** Which control host owns the container; two installations may share a daemon. */
  installation: "agent-platform.installation",
  managed: "agent-platform.managed",
  operationId: "agent-platform.operation-id",
  sessionId: "agent-platform.session-id",
} as const;

/**
 * Everything the worker needs for its bootstrap claim
 * (`bootstrapClaimRequestSchema`): identity, generation, nonce, where to call.
 * Labels are invisible from inside the container, so these ride on env.
 */
export const ENV = {
  bootstrapNonce: "WORKER_BOOTSTRAP_NONCE",
  executionGeneration: "WORKER_EXECUTION_GENERATION",
  executionId: "WORKER_EXECUTION_ID",
  gatewayUrl: "WORKER_GATEWAY_URL",
  /** Points at the tmpfs HOME, whatever the image's /etc/passwd says. */
  home: "HOME",
  /**
   * Both spellings, because tools are split on which one they read. They are
   * a convenience, not the control: the worker network has no route off
   * itself, so a client that ignores them reaches nothing at all.
   */
  httpProxy: "HTTP_PROXY",
  httpProxyLower: "http_proxy",
  httpsProxy: "HTTPS_PROXY",
  httpsProxyLower: "https_proxy",
  noProxy: "NO_PROXY",
  noProxyLower: "no_proxy",
} as const;

/** The worker's own loopback is the only thing worth not proxying. */
export const NO_PROXY_VALUE = "localhost,127.0.0.1,::1";

/**
 * Bumped whenever the isolation a worker container is created with changes.
 * A running container that predates the current value keeps whatever it was
 * created with — an upgrade does not reach inside it — so the scheduler has
 * to be told to replace it instead of reporting it healthy.
 *
 * 1: non-root, read-only rootfs, dropped caps, per-session volume, bridge.
 * 2: internal worker network and egress proxy, no host-gateway mapping.
 */
export const ISOLATION_CONTRACT = 2;

/**
 * What goes in the label: the contract version and a fingerprint of the
 * settings that shape the isolation. The version alone would miss a moved
 * network or a repointed proxy, neither of which needs a code change, and
 * both of which leave the old container on the old boundary.
 */
export function isolationStampFor(config: LocalDockerBackendConfig): string {
  const shape = JSON.stringify([
    config.egressProxyUrl,
    config.homeDir,
    config.network,
    NO_PROXY_VALUE,
    config.tmpfsSizeBytes,
    config.user,
    config.workspaceDir,
  ]);
  const digest = createHash("sha256").update(shape).digest("hex").slice(0, 16);
  return `${ISOLATION_CONTRACT}:${digest}`;
}

const CONTAINER_NAME_PREFIX = "ap-worker-";
const VOLUME_PREFIX = "ap-ws-";
// Docker: [a-zA-Z0-9][a-zA-Z0-9_.-]*
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Deterministic per intent, so a retried create collides instead of doubling. */
/**
 * Container and volume names are daemon-global, so both carry the
 * installation id: two installations sharing a daemon (or a cloned database
 * with the same ids) never collide on names or mount each other's workspace.
 */
export function containerNameFor(
  ref: ExecutionRef,
  installationId: string,
): string {
  if (!SAFE_NAME.test(ref.executionId)) {
    throw new Error(
      `Execution id ${ref.executionId} cannot be used as a Docker name`,
    );
  }
  return `${CONTAINER_NAME_PREFIX}${installationId}-${ref.executionId}-g${ref.generation}`;
}

export function workspaceVolumeFor(
  sessionId: string,
  installationId: string,
): string {
  if (!SAFE_NAME.test(sessionId)) {
    throw new Error(`Session id ${sessionId} cannot be used as a volume name`);
  }
  return `${VOLUME_PREFIX}${installationId}-${sessionId}`;
}

export class ExecutionConflictError extends Error {
  constructor(
    readonly ref: ExecutionRef,
    readonly expectedOperationId: string,
    readonly foundOperationId: string | undefined,
  ) {
    super(
      `Container for execution ${ref.executionId} generation ${ref.generation} belongs to operation ${foundOperationId ?? "<none>"}, not ${expectedOperationId}`,
    );
    this.name = "ExecutionConflictError";
  }
}

/**
 * A container built under an isolation contract this host does not know.
 * Adopting it would trust a boundary we cannot check, replacing it would
 * swap it for a weaker one, so the pass refuses it and says so.
 */
export class IsolationContractError extends Error {
  constructor(
    readonly ref: ExecutionRef,
    readonly found: string,
  ) {
    super(
      `Container for execution ${ref.executionId} generation ${ref.generation} carries isolation ${found}, newer than this control host's ${ISOLATION_CONTRACT}; roll forward or remove it deliberately`,
    );
    this.name = "IsolationContractError";
  }
}

export class LocalDockerBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  private readonly client: DockerClient;
  private readonly config: LocalDockerBackendConfig;

  constructor(config: LocalDockerBackendConfig, client?: DockerClient) {
    this.config = validateLocalDockerConfig(config);
    this.client =
      client ??
      new DockerClient(config.dockerHost, config.apiVersion, {
        timeoutMs: config.requestTimeoutMs,
      });
  }

  capabilities(): ExecutionBackendCapabilities {
    return { suspend: false };
  }

  /**
   * Refuses to launch onto a network a worker could route off. The whole
   * egress policy rests on the worker network being `internal`, so this is
   * checked against the daemon once per process rather than assumed from a
   * name in the environment.
   */
  async verifyNetworkIsolation(): Promise<void> {
    const network = await this.client.inspectNetwork(this.config.network);
    if (network === null) {
      throw new Error(
        `Docker network ${this.config.network} does not exist; create it before launching workers`,
      );
    }
    if (!network.Internal) {
      throw new Error(
        `Docker network ${this.config.network} is not internal; a worker on it can reach the host and the LAN directly`,
      );
    }
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    const name = containerNameFor(intent, this.config.installationId);
    // Two passes at most. The second is the one that follows a lost create
    // race, and it judges the winner by the same rules — a container that
    // appeared out of a race is not more trustworthy than one that was
    // already there. A second clash means another launcher is fighting for
    // the name, which is a conflict to report, not a loop to spin in.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.client.inspectContainer(name);
      if (existing) {
        const verdict = contractVerdictOf(existing, this.config);
        if (verdict === "newer") {
          throw new IsolationContractError(
            intent,
            existing.Config.Labels?.[LABELS.isolation] ?? "<none>",
          );
        }
        if (verdict === "current") return this.adopt(intent, existing);
        // Same intent, older isolation: adopting it would carry the weaker
        // container forward, so it is removed and created again. Another
        // operation's container is still a conflict, never ours to destroy.
        this.assertSameLaunch(intent, existing);
        await this.client.stopAndRemoveContainer(
          existing.Id,
          this.config.stopTimeoutSeconds,
        );
      }
      try {
        // The credential is minted here and nowhere else: it lives in this
        // one request body, reaches the container as an env var, and is only
        // ever stored as a hash. Adopting an existing container skips this,
        // so a worker that is already running keeps the nonce it was given.
        await this.client.createContainer(name, await this.createBody(intent));
      } catch (error) {
        // Another launcher (or an earlier attempt whose reply was lost) won.
        if (!(error instanceof DockerApiError) || error.status !== 409) {
          throw error;
        }
        continue;
      }
      await this.client.startContainer(name);
      const started = await this.client.inspectContainer(name);
      return {
        created: true,
        providerRef: started?.Id ?? name,
        state: started ? stateOf(started.State.Status) : "pending",
      };
    }
    throw new Error(
      `Container ${name} was taken by another launcher on every attempt`,
    );
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const container = await this.client.inspectContainer(
      containerNameFor(ref, this.config.installationId),
    );
    const observedAt = new Date();
    if (!container) {
      return { found: false, observedAt, providerRef: null, state: "unknown" };
    }
    // Fail closed: a same-named container that is not ours (other
    // installation, other generation, other execution) must never be
    // reported as this execution's healthy resource.
    this.assertOwned(ref, container);
    const verdict = contractVerdictOf(container, this.config);
    if (verdict === "newer") {
      // Neither healthy nor ours to replace. Throwing leaves the row live and
      // the pass non-zero, which is the only honest answer.
      throw new IsolationContractError(
        ref,
        container.Config.Labels?.[LABELS.isolation] ?? "<none>",
      );
    }
    const state = stateOf(container.State.Status);
    return {
      ...(state === "terminated" ? { exitCode: container.State.ExitCode } : {}),
      found: true,
      observedAt,
      providerRef: container.Id,
      state,
      ...(verdict === "current" ? {} : { stale: true }),
    };
  }

  async listManaged(): Promise<ManagedExecution[]> {
    const containers = await this.client.listContainers([
      `${LABELS.managed}=true`,
      `${LABELS.installation}=${this.config.installationId}`,
    ]);
    const managed: ManagedExecution[] = [];
    for (const container of containers) {
      const labels = container.Labels ?? {};
      const executionId = labels[LABELS.executionId];
      const generation = Number(labels[LABELS.generation]);
      if (!executionId || !Number.isInteger(generation)) continue;
      managed.push({
        executionId,
        generation,
        providerRef: container.Id,
        sessionId: labels[LABELS.sessionId] ?? null,
        state: stateOf(container.State),
      });
    }
    return managed;
  }

  async terminate(ref: ExecutionRef): Promise<TerminateExecutionResult> {
    const name = containerNameFor(ref, this.config.installationId);
    const container = await this.client.inspectContainer(name);
    if (!container) {
      // The name encodes the generation, so a different generation of the
      // same execution lives under another name. Find it only to report it.
      const siblings = await this.client.listContainers([
        `${LABELS.executionId}=${ref.executionId}`,
        `${LABELS.installation}=${this.config.installationId}`,
      ]);
      const other = siblings
        .map((c) => Number(c.Labels?.[LABELS.generation]))
        .find((g) => Number.isInteger(g) && g !== ref.generation);
      return other === undefined
        ? { outcome: "absent" }
        : { foundGeneration: other, outcome: "generation_mismatch" };
    }
    const owner = container.Config.Labels?.[LABELS.installation];
    if (owner !== this.config.installationId) {
      throw new ExecutionConflictError(ref, this.config.installationId, owner);
    }
    const labelled = Number(container.Config.Labels?.[LABELS.generation]);
    if (labelled !== ref.generation) {
      return { foundGeneration: labelled, outcome: "generation_mismatch" };
    }
    await this.client.stopAndRemoveContainer(
      container.Id,
      this.config.stopTimeoutSeconds,
    );
    return { outcome: "terminated", providerRef: container.Id };
  }

  /** The container under this name has to be this very launch, or hands off. */
  private assertSameLaunch(
    intent: LaunchIntent,
    container: ContainerInspect,
  ): void {
    const operationId = container.Config.Labels?.[LABELS.operationId];
    const owner = container.Config.Labels?.[LABELS.installation];
    if (
      operationId !== intent.operationId ||
      owner !== this.config.installationId
    ) {
      throw new ExecutionConflictError(intent, intent.operationId, operationId);
    }
  }

  private assertOwned(ref: ExecutionRef, container: ContainerInspect): void {
    const labels = container.Config.Labels ?? {};
    if (
      labels[LABELS.installation] !== this.config.installationId ||
      labels[LABELS.executionId] !== ref.executionId ||
      Number(labels[LABELS.generation]) !== ref.generation
    ) {
      throw new ExecutionConflictError(
        ref,
        `${this.config.installationId}/${ref.executionId}/g${ref.generation}`,
        `${labels[LABELS.installation]}/${labels[LABELS.executionId]}/g${labels[LABELS.generation]}`,
      );
    }
  }

  private async adopt(
    intent: LaunchIntent,
    container: ContainerInspect,
  ): Promise<EnsureExecutionResult> {
    this.assertSameLaunch(intent, container);
    let state = stateOf(container.State.Status);
    if (state === "pending") {
      await this.client.startContainer(container.Id);
      const started = await this.client.inspectContainer(container.Id);
      if (started) state = stateOf(started.State.Status);
    }
    return { created: false, providerRef: container.Id, state };
  }

  private async createBody(intent: LaunchIntent): Promise<ContainerCreateBody> {
    const { config } = this;
    // Docker reads 0 (and for pids, -1) as "no limit"; the isolation contract
    // says every worker is bounded, so refuse anything that would drop one.
    const { cpus, memoryBytes, pidsLimit } = intent.resources;
    const nanoCpus = Math.round(cpus * 1_000_000_000);
    if (!Number.isFinite(cpus) || nanoCpus < 1) {
      throw new Error(`cpus ${cpus} rounds to no CPU limit`);
    }
    if (!Number.isInteger(memoryBytes) || memoryBytes < 1) {
      throw new Error(`memoryBytes ${memoryBytes} is not a positive limit`);
    }
    if (!Number.isInteger(pidsLimit) || pidsLimit < 1) {
      throw new Error(`pidsLimit ${pidsLimit} is not a positive limit`);
    }
    // tmpfs mounts are root-owned unless told otherwise; the worker is not
    // root, so hand both of its writable dirs to its uid/gid.
    const [uid, gid = uid] = config.user.split(":");
    const tmpfsOptions = `rw,nosuid,nodev,size=${config.tmpfsSizeBytes},uid=${uid},gid=${gid}`;
    // Last, so a limit this host refuses never costs the launch a nonce.
    const bootstrapNonce = await intent.issueBootstrapNonce();
    return {
      ...(config.command ? { Cmd: config.command } : {}),
      Env: [
        `${ENV.bootstrapNonce}=${bootstrapNonce}`,
        `${ENV.executionGeneration}=${intent.generation}`,
        `${ENV.executionId}=${intent.executionId}`,
        `${ENV.gatewayUrl}=${config.gatewayUrl}`,
        `${ENV.home}=${config.homeDir}`,
        `${ENV.httpProxy}=${config.egressProxyUrl}`,
        `${ENV.httpProxyLower}=${config.egressProxyUrl}`,
        `${ENV.httpsProxy}=${config.egressProxyUrl}`,
        `${ENV.httpsProxyLower}=${config.egressProxyUrl}`,
        `${ENV.noProxy}=${NO_PROXY_VALUE}`,
        `${ENV.noProxyLower}=${NO_PROXY_VALUE}`,
      ],
      HostConfig: {
        CapDrop: ["ALL"],
        // No ExtraHosts: `host.docker.internal` would be a route to the
        // daemon host that bypasses the proxy, and on an internal network it
        // would not work anyway. The gateway is reached through the proxy.
        Memory: intent.resources.memoryBytes,
        Mounts: [
          {
            Source: workspaceVolumeFor(intent.sessionId, config.installationId),
            Target: config.workspaceDir,
            Type: "volume",
          },
        ],
        NanoCpus: nanoCpus,
        NetworkMode: config.network,
        PidsLimit: intent.resources.pidsLimit,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: {
          "/tmp": tmpfsOptions,
          [config.homeDir]: tmpfsOptions,
        },
      },
      Image: intent.image,
      Labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: String(intent.generation),
        [LABELS.installation]: config.installationId,
        [LABELS.isolation]: isolationStampFor(config),
        [LABELS.managed]: "true",
        [LABELS.operationId]: intent.operationId,
        [LABELS.sessionId]: intent.sessionId,
      },
      User: config.user,
    };
  }
}

/**
 * `newer` is neither: the label says a control host we do not know built it,
 * and nothing here can tell whether its network and proxy are the ones this
 * host would demand. Both adopting it and replacing it are wrong.
 */
function contractVerdictOf(
  container: ContainerInspect,
  config: LocalDockerBackendConfig,
): "current" | "newer" | "stale" {
  const stamp = container.Config.Labels?.[LABELS.isolation];
  if (stamp === undefined) return "stale";
  const version = Number(stamp.split(":")[0]);
  if (!Number.isInteger(version) || version < 1) return "stale";
  if (version > ISOLATION_CONTRACT) return "newer";
  return stamp === isolationStampFor(config) ? "current" : "stale";
}

/** Docker container status → the platform's execution state. */
export function stateOf(status: string): ExecutionState {
  switch (status) {
    case "created":
      return "pending";
    case "running":
    case "restarting":
      return "running";
    case "paused":
      return "suspended";
    case "removing":
      return "terminating";
    case "exited":
    case "dead":
      return "terminated";
    default:
      return "unknown";
  }
}
