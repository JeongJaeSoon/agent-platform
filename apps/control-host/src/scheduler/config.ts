import {
  integerSetting,
  positiveNumberSetting,
} from "@agent-platform/contracts/settings";
import {
  type LocalDockerBackendConfig,
  type LocalDockerBackendEnvironment,
  localDockerConfigFromEnv,
} from "@agent-platform/execution-local-docker";
import { type LogLevel, logLevelFromEnv } from "@agent-platform/observability";
import {
  DEFAULT_STOPPED_WORKSPACE_TTL_MS,
  type ExecutionResources,
  type InstallationLimits,
  type InstallationLimitsEnvironment,
  installationLimitsFromEnv,
} from "@agent-platform/platform";

export type SchedulerEnvironment = LocalDockerBackendEnvironment &
  InstallationLimitsEnvironment & {
    DATABASE_URL?: string | undefined;
    EXECUTION_WORKSPACE_STOPPED_TTL_SEC?: string | undefined;
    LOG_LEVEL?: string | undefined;
    QUEUE_DATABASE_URL?: string | undefined;
    WORKER_CPUS?: string | undefined;
    WORKER_IMAGE?: string | undefined;
    WORKER_MEMORY_MB?: string | undefined;
    WORKER_PIDS_LIMIT?: string | undefined;
  };

export type SchedulerConfig = {
  databaseUrl: string;
  docker: LocalDockerBackendConfig;
  drainDeadlineMs: number;
  image: string;
  limits: InstallationLimits;
  logLevel: LogLevel;
  resources: ExecutionResources;
  slotLimit: number;
  stoppedWorkspaceTtlMs: number;
};

export function schedulerConfigFromEnv(
  environment: SchedulerEnvironment,
): SchedulerConfig {
  const databaseUrl =
    environment.DATABASE_URL || environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  const image = environment.WORKER_IMAGE;
  if (!image) throw new Error("WORKER_IMAGE is required");
  // The adapter defaults this for tests; a real scheduler must say which
  // installation it is, or two installations on one daemon reap each other.
  if (!environment.EXECUTION_INSTALLATION_ID) {
    throw new Error("EXECUTION_INSTALLATION_ID is required");
  }
  // The same parser the API starts with, so the two processes cannot run
  // under different limits from one env file.
  const limits = installationLimitsFromEnv(environment);
  const logLevel = logLevelFromEnv(environment.LOG_LEVEL);
  return {
    databaseUrl,
    // A claimed worker on an older isolation contract finishes its turn
    // before it is replaced (94S-250). No turn outlasts MAX_TURN_SECONDS;
    // the grace covers the finalize and checkpoint that end it.
    drainDeadlineMs: limits.maxTurnSeconds * 1_000 + DRAIN_FINALIZE_GRACE_MS,
    docker: {
      ...localDockerConfigFromEnv(environment),
      workerLimits: {
        maxTurnSeconds: limits.maxTurnSeconds,
        providerMaxRetries: limits.providerMaxRetries,
      },
      logLevel,
    },
    image,
    limits,
    logLevel,
    resources: {
      cpus: cpuShare(environment),
      memoryBytes:
        integerSetting(environment, "WORKER_MEMORY_MB", {
          min: 1,
          default: 2048,
        }) *
        1024 *
        1024,
      pidsLimit: integerSetting(environment, "WORKER_PIDS_LIMIT", {
        min: 1,
        default: 512,
      }),
    },
    slotLimit: limits.executionSlotLimit,
    // Zero is a real setting: a stopped session's workspace goes on the
    // next pass, and a resume restores from the checkpoint.
    stoppedWorkspaceTtlMs:
      integerSetting(environment, "EXECUTION_WORKSPACE_STOPPED_TTL_SEC", {
        min: 0,
        default: DEFAULT_STOPPED_WORKSPACE_TTL_MS / 1_000,
      }) * 1_000,
  };
}

/**
 * A kill does not wait for a busy worker to drain (94S-385), but a pass can
 * still wait out one whole stop: ensure removes a container it cannot adopt,
 * and the teardown of an unclaimed one, before building again. A pass killed
 * there counts as failed, and three in a row restart the scheduler.
 */
export function assertPassOutlastsStop(
  passTimeoutMs: number,
  docker: Pick<
    LocalDockerBackendConfig,
    "requestTimeoutMs" | "stopTimeoutSeconds"
  >,
): void {
  if (
    passTimeoutMs <=
    docker.stopTimeoutSeconds * 1_000 + docker.requestTimeoutMs
  ) {
    throw new Error(
      "SCHEDULER_PASS_TIMEOUT_SEC must be greater than EXECUTION_DOCKER_STOP_TIMEOUT_SEC + EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC: a pass that waits out a worker's stop would be killed and counted as failed",
    );
  }
}

const DRAIN_FINALIZE_GRACE_MS = 5 * 60_000;

/** Docker's smallest CPU quota is 0.01 CPU; below that NanoCpus rounds to "no limit". */
const MIN_CPUS = 0.01;

function cpuShare(environment: SchedulerEnvironment): number {
  const parsed = positiveNumberSetting(environment, "WORKER_CPUS", {
    default: 1,
  });
  if (parsed < MIN_CPUS) {
    throw new Error(`WORKER_CPUS must be at least ${MIN_CPUS}`);
  }
  return parsed;
}
