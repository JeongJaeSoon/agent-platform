import {
  DEFAULT_DOCKER_API_VERSION,
  DEFAULT_DOCKER_HOST,
  DEFAULT_DOCKER_REQUEST_TIMEOUT_MS,
} from "./docker-client.ts";

export type LocalDockerBackendConfig = {
  /** Only networks in this list may be used; the empty list means none. */
  allowedNetworks: string[];
  apiVersion: string;
  /** Overrides the image entrypoint; tests use it to run a sleeping busybox. */
  command?: string[];
  dockerHost: string;
  /** Handed to the worker as `WORKER_GATEWAY_URL`. */
  gatewayUrl: string;
  /** Mounted as tmpfs so the read-only rootfs still has a writable HOME. */
  homeDir: string;
  network: string;
  /** Deadline for each Docker Engine API call. */
  requestTimeoutMs: number;
  /** Seconds between SIGTERM and SIGKILL on terminate. */
  stopTimeoutSeconds: number;
  tmpfsSizeBytes: number;
  /** `uid:gid`; must not be root. */
  user: string;
  /** Mount point of the per-session volume. */
  workspaceDir: string;
};

/** Shaped like the process environment so it can be passed straight through. */
export type LocalDockerBackendEnvironment = {
  DOCKER_API_VERSION?: string | undefined;
  DOCKER_HOST?: string | undefined;
  /** Whitespace-separated entrypoint override, e.g. `sleep 600` for tests. */
  EXECUTION_DOCKER_COMMAND?: string | undefined;
  EXECUTION_DOCKER_HOME_DIR?: string | undefined;
  EXECUTION_DOCKER_NETWORK?: string | undefined;
  EXECUTION_DOCKER_NETWORK_ALLOWLIST?: string | undefined;
  EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC?: string | undefined;
  EXECUTION_DOCKER_STOP_TIMEOUT_SEC?: string | undefined;
  EXECUTION_DOCKER_TMPFS_SIZE_MB?: string | undefined;
  EXECUTION_DOCKER_USER?: string | undefined;
  EXECUTION_DOCKER_WORKSPACE_DIR?: string | undefined;
  WORKER_GATEWAY_URL?: string | undefined;
  [key: string]: string | undefined;
};

export const DEFAULT_WORKER_USER = "1000:1000";
export const DEFAULT_WORKER_NETWORK = "bridge";

export function localDockerConfigFromEnv(
  environment: LocalDockerBackendEnvironment,
): LocalDockerBackendConfig {
  const gatewayUrl = environment.WORKER_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("WORKER_GATEWAY_URL is required");
  const network =
    environment.EXECUTION_DOCKER_NETWORK ?? DEFAULT_WORKER_NETWORK;
  const allowedNetworks = (
    environment.EXECUTION_DOCKER_NETWORK_ALLOWLIST ?? DEFAULT_WORKER_NETWORK
  )
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const command = (environment.EXECUTION_DOCKER_COMMAND ?? "")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  return validateLocalDockerConfig({
    allowedNetworks,
    apiVersion: environment.DOCKER_API_VERSION ?? DEFAULT_DOCKER_API_VERSION,
    ...(command.length > 0 ? { command } : {}),
    dockerHost: environment.DOCKER_HOST ?? DEFAULT_DOCKER_HOST,
    gatewayUrl,
    homeDir: environment.EXECUTION_DOCKER_HOME_DIR ?? "/home/worker",
    network,
    requestTimeoutMs:
      environment.EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC === undefined
        ? DEFAULT_DOCKER_REQUEST_TIMEOUT_MS
        : positiveInteger(
            environment.EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC,
            "EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC",
          ) * 1_000,
    stopTimeoutSeconds: positiveInteger(
      environment.EXECUTION_DOCKER_STOP_TIMEOUT_SEC ?? "10",
      "EXECUTION_DOCKER_STOP_TIMEOUT_SEC",
    ),
    tmpfsSizeBytes:
      positiveInteger(
        environment.EXECUTION_DOCKER_TMPFS_SIZE_MB ?? "256",
        "EXECUTION_DOCKER_TMPFS_SIZE_MB",
      ) *
      1024 *
      1024,
    user: environment.EXECUTION_DOCKER_USER ?? DEFAULT_WORKER_USER,
    workspaceDir: environment.EXECUTION_DOCKER_WORKSPACE_DIR ?? "/workspace",
  });
}

/** The invariants the ticket lists for a worker container, checked once. */
export function validateLocalDockerConfig(
  config: LocalDockerBackendConfig,
): LocalDockerBackendConfig {
  if (!config.allowedNetworks.includes(config.network)) {
    throw new Error(
      `Docker network ${config.network} is not in the allowlist [${config.allowedNetworks.join(", ")}]`,
    );
  }
  if (config.network === "host") {
    throw new Error("Docker network host is never allowed for workers");
  }
  // Docker accepts any decimal spelling of uid 0 ("00", "000:1000"), so
  // compare the parsed number, not the string.
  const [uid, gid] = config.user.split(":");
  if (
    !uid ||
    !/^\d+$/.test(uid) ||
    Number.parseInt(uid, 10) === 0 ||
    (gid !== undefined &&
      (!/^\d+$/.test(gid) || Number.parseInt(gid, 10) === 0))
  ) {
    throw new Error(
      `Worker user ${config.user} must be a numeric non-root uid[:gid]`,
    );
  }
  if (!config.homeDir.startsWith("/") || !config.workspaceDir.startsWith("/")) {
    throw new Error("homeDir and workspaceDir must be absolute paths");
  }
  if (config.homeDir === config.workspaceDir) {
    throw new Error("homeDir and workspaceDir must differ");
  }
  try {
    new URL(config.gatewayUrl);
  } catch {
    throw new Error(`WORKER_GATEWAY_URL ${config.gatewayUrl} is not a URL`);
  }
  return config;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
