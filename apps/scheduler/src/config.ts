import {
  type LocalDockerBackendConfig,
  type LocalDockerBackendEnvironment,
  localDockerConfigFromEnv,
} from "@agent-platform/execution-local-docker";
import {
  DEFAULT_EXECUTION_SLOT_LIMIT,
  type ExecutionResources,
} from "@agent-platform/platform";

export type SchedulerEnvironment = LocalDockerBackendEnvironment & {
  DATABASE_URL?: string | undefined;
  EXECUTION_SLOT_LIMIT?: string | undefined;
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
  image: string;
  logLevel: string | undefined;
  resources: ExecutionResources;
  slotLimit: number;
};

export function schedulerConfigFromEnv(
  environment: SchedulerEnvironment,
): SchedulerConfig {
  const databaseUrl =
    environment.DATABASE_URL ?? environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  const image = environment.WORKER_IMAGE;
  if (!image) throw new Error("WORKER_IMAGE is required");
  return {
    databaseUrl,
    docker: localDockerConfigFromEnv(environment),
    image,
    logLevel: environment.LOG_LEVEL,
    resources: {
      cpus: positiveNumber(environment.WORKER_CPUS ?? "1", "WORKER_CPUS"),
      memoryBytes:
        positiveInteger(
          environment.WORKER_MEMORY_MB ?? "2048",
          "WORKER_MEMORY_MB",
        ) *
        1024 *
        1024,
      pidsLimit: positiveInteger(
        environment.WORKER_PIDS_LIMIT ?? "512",
        "WORKER_PIDS_LIMIT",
      ),
    },
    slotLimit: nonNegativeInteger(
      environment.EXECUTION_SLOT_LIMIT ?? String(DEFAULT_EXECUTION_SLOT_LIMIT),
      "EXECUTION_SLOT_LIMIT",
    ),
  };
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
