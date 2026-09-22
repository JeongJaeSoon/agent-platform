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
  ManagedWorkspace,
  TerminateExecutionResult,
  WorkspaceRemovalResult,
} from "@agent-platform/platform";
import {
  type LocalDockerBackendConfig,
  validateLocalDockerConfig,
  type WorkspaceQuota,
} from "./config.ts";
import {
  type ContainerCreateBody,
  type ContainerInspect,
  DockerApiError,
  DockerClient,
  type ImageInspect,
  type VolumeInspect,
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
  /**
   * On the preflight's throwaway volume. Deliberately *not* `managed`: GC
   * judges by that label, and a probe has no session for it to match, so
   * labelling it managed would hand the reaper something it can only ever
   * leave alone. This label is what makes the probe ours to delete.
   */
  quotaProbe: "agent-platform.quota-probe",
  /** On the workspace volume: which ceiling it was created under. */
  workspaceQuota: "agent-platform.workspace-quota",
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
 * 3: the workspace volume is created explicitly, under a byte quota.
 */
export const ISOLATION_CONTRACT = 3;

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
    // A container adopted across a quota change would keep mounting the
    // volume it was created with, whose ceiling cannot be raised or lowered
    // in place. Making it stale forces the replacement through
    // `ensureWorkspaceVolume`, which is what reports the mismatch.
    quotaStampOf(config.workspaceQuota),
  ]);
  const digest = createHash("sha256").update(shape).digest("hex").slice(0, 16);
  return `${ISOLATION_CONTRACT}:${digest}`;
}

const CONTAINER_NAME_PREFIX = "ap-worker-";
const VOLUME_PREFIX = "ap-ws-";
/** The preflight probe's volume; see `LABELS.quotaProbe` for its labels. */
const QUOTA_PROBE_PREFIX = "ap-quota-probe-";
/** Docker's own wording when the volume driver cannot honour `size`. */
const NO_QUOTA_SUPPORT = "no quota support";
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

/**
 * The prefix every one of this session's workspace volumes carries.
 *
 * A workspace is found by its labels rather than by a name derived from the
 * session, because the `local` driver does not put a ceiling back on a name
 * it has already seen. Measured on xfs+prjquota (Docker 27.5.1): the first
 * create of a name bounds the volume at the requested 64 MiB, and the same
 * name removed and created again answers 201 with `Options.size` unchanged
 * while `df` inside a container reports the whole 8 GiB filesystem. The
 * daemon keeps the project id it assigned to that path and never tags the
 * new directory with it, so `size` is metadata with nothing behind it and
 * no API call can tell the two apart. A name is therefore used once.
 */
export function workspaceVolumePrefixFor(
  sessionId: string,
  installationId: string,
): string {
  if (!SAFE_NAME.test(sessionId)) {
    throw new Error(`Session id ${sessionId} cannot be used as a volume name`);
  }
  return `${VOLUME_PREFIX}${installationId}-${sessionId}-`;
}

/** What the volume's quota label holds, and part of the isolation stamp. */
export function quotaStampOf(quota: WorkspaceQuota): string {
  return quota.mode === "off" ? "off" : `enforced:${quota.sizeBytes}`;
}

/**
 * The volume under this session's workspace name is not the one this host
 * would create — wrong ceiling, wrong owner, or wrong session. Reported
 * rather than fixed: the volume carries a session's working tree across
 * generations, a quota cannot be changed on an existing volume, and deleting
 * it to re-create it would throw that tree away. So the launch stops and
 * says which volume and what is wrong with it.
 */
export class WorkspaceQuotaError extends Error {
  constructor(
    readonly volume: string,
    readonly reason: string,
  ) {
    super(`Workspace volume ${volume} ${reason}`);
    this.name = "WorkspaceQuotaError";
  }
}

/**
 * The preflight's own name is taken by something it did not create. Deleting
 * it would destroy a volume this host has no claim on, and reusing it would
 * let a volume made elsewhere stand in for the proof the daemon owes.
 */
export class QuotaProbeNameTakenError extends Error {
  constructor(readonly volume: string) {
    super(
      `Volume ${volume} is not this host's quota probe. The preflight needs that name and will not remove a volume it did not create; rename or remove it deliberately.`,
    );
    this.name = "QuotaProbeNameTakenError";
  }
}

/**
 * The image declares a `VOLUME` of its own. Docker materializes one anonymous
 * volume per declared path on every container built from it: writable, no
 * ceiling, none of our labels. That is a hole straight through the workspace
 * quota, so the image is refused rather than launched around.
 */
export class ImageVolumeError extends Error {
  constructor(
    readonly image: string,
    readonly paths: string[],
  ) {
    super(
      `Image ${image} declares VOLUME ${paths.join(", ")}. Docker would give each one an ` +
        "unbounded, unlabelled anonymous volume that no quota covers and no GC reclaims. " +
        "Build the worker image without those declarations.",
    );
    this.name = "ImageVolumeError";
  }
}

/** The daemon's storage cannot carry a quota (no xfs `prjquota` behind it). */
export class WorkspaceQuotaUnsupportedError extends Error {
  constructor(cause: string) {
    super(
      `This Docker daemon cannot put a size quota on a local volume (${cause}). ` +
        "An unbounded workspace lets one worker fill the daemon's disk and take " +
        "every other session on it down, so nothing is launched. Move the daemon's " +
        "storage onto xfs with prjquota, or opt out deliberately with " +
        "EXECUTION_WORKSPACE_QUOTA=off.",
    );
    this.name = "WorkspaceQuotaUnsupportedError";
  }
}

function isQuotaUnsupported(error: unknown): boolean {
  return (
    error instanceof DockerApiError && error.body.includes(NO_QUOTA_SUPPORT)
  );
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

  /**
   * Refuses to launch onto a daemon that would give the workspace no
   * ceiling. The `local` driver only honours `size` when the storage behind
   * it can carry a project quota, and it says so at create time — so the
   * cheapest honest check is to create one and throw it away. Checked once
   * per process, beside `verifyNetworkIsolation`.
   */
  async verifyWorkspaceQuota(): Promise<void> {
    const quota = this.config.workspaceQuota;
    if (quota.mode === "off") return;
    const name = `${QUOTA_PROBE_PREFIX}${this.config.installationId}-${crypto.randomUUID().slice(0, 8)}`;
    const labels = {
      [LABELS.installation]: this.config.installationId,
      [LABELS.quotaProbe]: "true",
    };
    // A probe under a name the daemon has already quota'd proves nothing —
    // see `workspaceVolumePrefixFor` — so each one takes a fresh name, and
    // what an interrupted probe left behind is cleaned up by its labels
    // instead. Failing to remove one is not worth refusing the launch over:
    // the volume is empty, and the probe below still has to pass.
    for (const stray of await this.client.listVolumes([
      `${LABELS.quotaProbe}=true`,
      `${LABELS.installation}=${this.config.installationId}`,
    ])) {
      await this.client.removeVolume(stray.Name).catch(() => undefined);
    }
    let volume: VolumeInspect;
    try {
      volume = await this.client.createVolume({
        Driver: "local",
        DriverOpts: { size: String(quota.sizeBytes) },
        Labels: labels,
        Name: name,
      });
    } catch (error) {
      if (isQuotaUnsupported(error)) {
        throw new WorkspaceQuotaUnsupportedError(messageOf(error));
      }
      throw error;
    }
    // Checked before the removal below, not inside it: a create onto a name
    // something else already holds answers with *that* volume, and deleting
    // it on the way out would destroy data this host has no claim on.
    if (
      volume.Labels?.[LABELS.quotaProbe] !== "true" ||
      volume.Labels?.[LABELS.installation] !== this.config.installationId
    ) {
      throw new QuotaProbeNameTakenError(name);
    }
    try {
      if (Number(volume.Options?.size) !== quota.sizeBytes) {
        throw new WorkspaceQuotaUnsupportedError(
          `the daemon accepted size=${quota.sizeBytes} but recorded ${volume.Options?.size ?? "no size option"}`,
        );
      }
    } finally {
      await this.client.removeVolume(name).catch(() => undefined);
    }
  }

  async listWorkspaces(): Promise<ManagedWorkspace[]> {
    const volumes = await this.client.listVolumes([
      `${LABELS.managed}=true`,
      `${LABELS.installation}=${this.config.installationId}`,
    ]);
    const youngerThan = Date.now() - this.config.workspaceGcMinAgeMs;
    const workspaces: ManagedWorkspace[] = [];
    for (const volume of volumes) {
      const createdAt = volume.CreatedAt ? new Date(volume.CreatedAt) : null;
      // The age gate is what keeps a launch in flight — volume created,
      // container not yet — from being reaped between the two calls. A
      // volume the daemon will not date cannot pass a gate it cannot be
      // measured against, so it is left alone.
      if (createdAt === null || Number.isNaN(createdAt.getTime())) continue;
      if (createdAt.getTime() > youngerThan) continue;
      workspaces.push({
        createdAt,
        id: volume.Name,
        sessionId: volume.Labels?.[LABELS.sessionId] ?? null,
      });
    }
    return workspaces;
  }

  async removeWorkspace(id: string): Promise<WorkspaceRemovalResult> {
    // Re-checked against the daemon rather than trusted from the listing:
    // between the two calls the volume may have been remade for a new
    // session, and the id alone carries no proof of ownership.
    const volume = await this.client.inspectVolume(id);
    if (volume === null) return { outcome: "absent" };
    const labels = volume.Labels ?? {};
    if (
      labels[LABELS.managed] !== "true" ||
      labels[LABELS.installation] !== this.config.installationId
    ) {
      return { outcome: "not_ours" };
    }
    try {
      await this.client.removeVolume(id);
    } catch (error) {
      // A container still holds it: the session it belongs to came back, or
      // a teardown is still in flight. Either way, not ours to force.
      if (error instanceof DockerApiError && error.status === 409) {
        return { outcome: "in_use" };
      }
      throw error;
    }
    return { outcome: "removed" };
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    const name = containerNameFor(intent, this.config.installationId);
    // A tag is mutable: the image inspected here and the image a later create
    // resolves need not be the same one. Creating from the id that was
    // actually inspected closes that window.
    const image = await this.inspectedImage(intent.image);
    const volume = await this.ensureWorkspaceVolume(intent.sessionId);
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
        await this.client.createContainer(
          name,
          await this.createBody(intent, image, volume),
        );
      } catch (error) {
        // Another launcher (or an earlier attempt whose reply was lost) won.
        if (!(error instanceof DockerApiError) || error.status !== 409) {
          throw error;
        }
        continue;
      }
      // The volume was checked before the create; a prune in between would
      // have had Docker silently conjure an unlabelled, unbounded one for the
      // mount. Nothing has run in the container yet, so this is the last
      // moment the container can still be thrown away instead of bounded.
      await this.assertWorkspaceStillBounded(name, intent.sessionId, volume);
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
    // A stale verdict is a demolition order: the scheduler terminates this
    // container and launches a replacement. Say so only once the replacement
    // is known to be launchable, because a workspace the new container cannot
    // be given would leave the session with neither worker — the old one gone,
    // the new one refused at volume creation, and nothing to retry into.
    if (verdict === "stale" && state !== "terminated") {
      const sessionId = container.Config.Labels?.[LABELS.sessionId];
      if (sessionId) await this.assertWorkspaceReplaceable(sessionId);
    }
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

  /**
   * The per-session workspace, created explicitly so it can carry both a
   * quota and the labels GC judges by.
   *
   * `POST /volumes/create` is not a create-or-fail: a name that already
   * exists comes back 201 with the *existing* volume, its original driver
   * options and labels intact and the ones just asked for silently dropped.
   * So the reply is the thing to check, not the status code.
   */
  private async ensureWorkspaceVolume(sessionId: string): Promise<string> {
    const { config } = this;
    const quota = config.workspaceQuota;
    const stamp = quotaStampOf(quota);
    // The session's own workspace, if it has one: resume must come back to
    // the tree it left, and only the labels say which volume that is.
    const existing = await this.findWorkspaceVolume(sessionId);
    if (existing !== null) {
      const problem = workspaceVolumeProblem(existing, sessionId, config);
      if (problem !== null)
        throw new WorkspaceQuotaError(existing.Name, problem);
      return existing.Name;
    }
    const name = `${workspaceVolumePrefixFor(sessionId, config.installationId)}${crypto.randomUUID().slice(0, 8)}`;
    let volume: VolumeInspect;
    try {
      volume = await this.client.createVolume({
        Driver: "local",
        ...(quota.mode === "enforced"
          ? { DriverOpts: { size: String(quota.sizeBytes) } }
          : {}),
        Labels: {
          [LABELS.installation]: config.installationId,
          [LABELS.managed]: "true",
          [LABELS.sessionId]: sessionId,
          [LABELS.workspaceQuota]: stamp,
        },
        Name: name,
      });
    } catch (error) {
      // Preflight should have caught this; a daemon can lose the capability
      // under a running control host, so the launch has to fail too.
      if (isQuotaUnsupported(error)) {
        throw new WorkspaceQuotaUnsupportedError(messageOf(error));
      }
      throw error;
    }
    const problem = workspaceVolumeProblem(volume, sessionId, config);
    if (problem !== null) throw new WorkspaceQuotaError(name, problem);
    return name;
  }

  /**
   * Whether the session's existing workspace could be handed to a new
   * container, asked without changing anything. The stale-replacement path
   * destroys a running container before it re-creates one, so it has to know
   * the answer *before* the teardown: a volume that `ensureWorkspaceVolume`
   * would reject leaves that session with no worker and no way back to one.
   */
  private async assertWorkspaceReplaceable(sessionId: string): Promise<void> {
    const volume = await this.findWorkspaceVolume(sessionId);
    // Nothing there is the easy case: the replacement creates it.
    if (volume === null) return;
    const problem = workspaceVolumeProblem(volume, sessionId, this.config);
    if (problem !== null) throw new WorkspaceQuotaError(volume.Name, problem);
  }

  /**
   * This session's workspace volume, by the labels that name it. Two of them
   * is not a case to pick a winner in: each may hold a different half of the
   * session's work, and mounting one would bury the other. Reported instead,
   * which leaves both on disk for an operator to compare.
   */
  private async findWorkspaceVolume(
    sessionId: string,
  ): Promise<VolumeInspect | null> {
    const found = await this.client.listVolumes([
      `${LABELS.managed}=true`,
      `${LABELS.installation}=${this.config.installationId}`,
      `${LABELS.sessionId}=${sessionId}`,
    ]);
    if (found.length === 0) {
      // Before names became single-use, a workspace was whatever sat under
      // the session's derived name — including the unlabelled volume Docker
      // conjures out of a mount spec. Those are still looked for, because
      // creating a fresh one beside such a volume would hand the session an
      // empty tree and bury the one it had. What is wrong with it is left to
      // `workspaceVolumeProblem`, which rejects it for the ceiling it cannot
      // prove; migrating it is 94S-225.
      return await this.client.inspectVolume(
        `${VOLUME_PREFIX}${this.config.installationId}-${sessionId}`,
      );
    }
    if (found.length > 1) {
      // Reported, not resolved: choosing between two workspaces needs to
      // know which one a worker actually wrote to, which nothing here can
      // tell. Worth resolving if a launch race is ever seen to produce it.
      throw new WorkspaceQuotaError(
        found
          .map((volume) => volume.Name)
          .sort()
          .join(", "),
        `session ${sessionId} has ${found.length} workspace volumes; only one can be mounted`,
      );
    }
    return found[0] ?? null;
  }

  /**
   * The image to launch, named by its id, once it is known to declare no
   * volumes of its own. The read-only rootfs and the bounded mounts are the
   * whole of what a worker may write to — unless its image declares a
   * `VOLUME`, which Docker honours by attaching a writable anonymous volume
   * outside all of it. An image the daemon does not have is refused rather
   * than passed through: a pull landing between that 404 and the create
   * would launch an image nothing has looked at, and nothing else in the
   * launch would notice the anonymous volume it brought. Nothing here pulls,
   * so a missing image could not have launched anyway.
   */
  private async inspectedImage(reference: string): Promise<string> {
    let inspected: ImageInspect | null;
    try {
      inspected = await this.client.inspectImage(reference);
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) {
        inspected = null;
      } else {
        throw error;
      }
    }
    if (inspected === null) {
      throw new Error(
        `Image ${reference} is not on this daemon; it cannot be inspected for declared volumes`,
      );
    }
    const declared = Object.keys(inspected.Config.Volumes ?? {});
    // The workspace path is ours; the image declaring it changes nothing,
    // because the mount spec names a volume for exactly that target.
    const extra = declared.filter((path) => path !== this.config.workspaceDir);
    if (extra.length > 0) throw new ImageVolumeError(reference, extra.sort());
    return inspected.Id || reference;
  }

  /**
   * The workspace this container was created against is still the bounded one
   * it was checked as. Between the check and the create, a `docker volume
   * prune` removes it and the create silently conjures a replacement with no
   * labels and no ceiling; the container is removed rather than started.
   */
  private async assertWorkspaceStillBounded(
    container: string,
    sessionId: string,
    name: string,
  ): Promise<void> {
    const volume = await this.client.inspectVolume(name);
    const problem =
      volume === null
        ? "disappeared between the check and the container"
        : workspaceVolumeProblem(volume, sessionId, this.config);
    if (problem === null) return;
    await this.client
      .stopAndRemoveContainer(container, this.config.stopTimeoutSeconds)
      .catch(() => undefined);
    throw new WorkspaceQuotaError(name, problem);
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

  private async createBody(
    intent: LaunchIntent,
    image: string,
    workspace: string,
  ): Promise<ContainerCreateBody> {
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
            Source: workspace,
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
      Image: image,
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
 * What is wrong with an existing volume for `sessionId`, or null when it is
 * exactly the one this host would create. Shared by the launch path and the
 * pre-teardown check so the two can never disagree about what is acceptable.
 */
function workspaceVolumeProblem(
  volume: VolumeInspect,
  sessionId: string,
  config: LocalDockerBackendConfig,
): string | null {
  const labels = volume.Labels ?? {};
  const owner = labels[LABELS.installation];
  const quota = config.workspaceQuota;
  const stamp = quotaStampOf(quota);
  // Only a volume that names a *different* owner is an ownership problem.
  // One that names none is the volume Docker used to conjure out of a mount
  // spec, and what is wrong with it is the missing ceiling, reported below.
  if (owner !== undefined && owner !== config.installationId) {
    return `belongs to installation ${owner}, not ${config.installationId}`;
  }
  if (labels[LABELS.workspaceQuota] !== stamp) {
    // Either it predates the quota (implicitly created, unlabelled and
    // unbounded) or it was created under a different ceiling.
    return (
      `was created under quota ${labels[LABELS.workspaceQuota] ?? "<none>"}, not ${stamp}; ` +
      "a volume's quota cannot be changed in place, so this session keeps whatever " +
      "worker it still has until the volume is retired deliberately (docker volume rm, " +
      "once its workspace is no longer needed) or the previous setting is restored"
    );
  }
  const size = volume.Options?.size;
  if (
    quota.mode === "enforced"
      ? Number(size) !== quota.sizeBytes
      : size !== undefined
  ) {
    return `carries the quota label ${stamp} but driver option size=${size ?? "<none>"}`;
  }
  // The ceiling is right, which says nothing about whose workspace this is.
  // A volume that carries the stamp but not the identity was made by hand or
  // for another session; mounting it would hand a session someone else's
  // working tree, and GC judges by these same labels, so one that is missing
  // them would never be reclaimed either.
  if (
    owner !== config.installationId ||
    labels[LABELS.managed] !== "true" ||
    labels[LABELS.sessionId] !== sessionId
  ) {
    return (
      `is not this session's workspace (managed=${labels[LABELS.managed] ?? "<none>"}, ` +
      `installation=${owner ?? "<none>"}, session=${labels[LABELS.sessionId] ?? "<none>"})`
    );
  }
  return null;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
