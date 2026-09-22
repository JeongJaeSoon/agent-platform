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
  managed: "agent-platform.managed",
  operationId: "agent-platform.operation-id",
  sessionId: "agent-platform.session-id",
} as const;

export const ENV = {
  bootstrapNonce: "WORKER_BOOTSTRAP_NONCE",
  gatewayUrl: "WORKER_GATEWAY_URL",
} as const;

const CONTAINER_NAME_PREFIX = "ap-worker-";
const VOLUME_PREFIX = "ap-ws-";
// Docker: [a-zA-Z0-9][a-zA-Z0-9_.-]*
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Deterministic per intent, so a retried create collides instead of doubling. */
export function containerNameFor(ref: ExecutionRef): string {
  if (!SAFE_NAME.test(ref.executionId)) {
    throw new Error(
      `Execution id ${ref.executionId} cannot be used as a Docker name`,
    );
  }
  return `${CONTAINER_NAME_PREFIX}${ref.executionId}-g${ref.generation}`;
}

export function workspaceVolumeFor(sessionId: string): string {
  if (!SAFE_NAME.test(sessionId)) {
    throw new Error(`Session id ${sessionId} cannot be used as a volume name`);
  }
  return `${VOLUME_PREFIX}${sessionId}`;
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

export class LocalDockerBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  private readonly client: DockerClient;
  private readonly config: LocalDockerBackendConfig;

  constructor(config: LocalDockerBackendConfig, client?: DockerClient) {
    this.config = validateLocalDockerConfig(config);
    this.client =
      client ?? new DockerClient(config.dockerHost, config.apiVersion);
  }

  capabilities(): ExecutionBackendCapabilities {
    return { suspend: false };
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    const name = containerNameFor(intent);
    const existing = await this.client.inspectContainer(name);
    if (existing) return this.adopt(intent, existing);
    try {
      await this.client.createContainer(name, this.createBody(intent));
    } catch (error) {
      // Another launcher (or an earlier attempt whose reply was lost) won.
      if (!(error instanceof DockerApiError) || error.status !== 409)
        throw error;
      const raced = await this.client.inspectContainer(name);
      if (!raced) throw error;
      return this.adopt(intent, raced);
    }
    await this.client.startContainer(name);
    const started = await this.client.inspectContainer(name);
    return {
      created: true,
      providerRef: started?.Id ?? name,
      state: started ? stateOf(started.State.Status) : "pending",
    };
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const container = await this.client.inspectContainer(containerNameFor(ref));
    const observedAt = new Date();
    if (!container) {
      return { found: false, observedAt, providerRef: null, state: "unknown" };
    }
    const state = stateOf(container.State.Status);
    return {
      ...(state === "terminated" ? { exitCode: container.State.ExitCode } : {}),
      found: true,
      observedAt,
      providerRef: container.Id,
      state,
    };
  }

  async listManaged(): Promise<ManagedExecution[]> {
    const containers = await this.client.listContainers([
      `${LABELS.managed}=true`,
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
    const name = containerNameFor(ref);
    const container = await this.client.inspectContainer(name);
    if (!container) {
      // The name encodes the generation, so a different generation of the
      // same execution lives under another name. Find it only to report it.
      const siblings = await this.client.listContainers([
        `${LABELS.executionId}=${ref.executionId}`,
      ]);
      const other = siblings
        .map((c) => Number(c.Labels?.[LABELS.generation]))
        .find((g) => Number.isInteger(g) && g !== ref.generation);
      return other === undefined
        ? { outcome: "absent" }
        : { foundGeneration: other, outcome: "generation_mismatch" };
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

  private async adopt(
    intent: LaunchIntent,
    container: ContainerInspect,
  ): Promise<EnsureExecutionResult> {
    const operationId = container.Config.Labels?.[LABELS.operationId];
    if (operationId !== intent.operationId) {
      throw new ExecutionConflictError(intent, intent.operationId, operationId);
    }
    let state = stateOf(container.State.Status);
    if (state === "pending") {
      await this.client.startContainer(container.Id);
      const started = await this.client.inspectContainer(container.Id);
      if (started) state = stateOf(started.State.Status);
    }
    return { created: false, providerRef: container.Id, state };
  }

  private createBody(intent: LaunchIntent): ContainerCreateBody {
    const { config } = this;
    const tmpfsOptions = `rw,nosuid,nodev,size=${config.tmpfsSizeBytes}`;
    return {
      ...(config.command ? { Cmd: config.command } : {}),
      Env: [
        `${ENV.bootstrapNonce}=${intent.bootstrapNonce}`,
        `${ENV.gatewayUrl}=${config.gatewayUrl}`,
      ],
      HostConfig: {
        CapDrop: ["ALL"],
        Memory: intent.resources.memoryBytes,
        Mounts: [
          {
            Source: workspaceVolumeFor(intent.sessionId),
            Target: config.workspaceDir,
            Type: "volume",
          },
        ],
        NanoCpus: Math.round(intent.resources.cpus * 1_000_000_000),
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
        [LABELS.managed]: "true",
        [LABELS.operationId]: intent.operationId,
        [LABELS.sessionId]: intent.sessionId,
      },
      User: config.user,
    };
  }
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
