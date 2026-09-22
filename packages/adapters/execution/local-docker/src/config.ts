import {
  DEFAULT_DOCKER_API_VERSION,
  DEFAULT_DOCKER_HOST,
  DEFAULT_DOCKER_REQUEST_TIMEOUT_MS,
} from "./docker-client.ts";

/**
 * `enforced` puts a byte ceiling on the per-session workspace volume through
 * the `local` driver's `size` option, which only holds on a daemon whose
 * storage sits on a quota-capable filesystem (xfs with `prjquota`). `off` is
 * the deliberate opt-out for daemons that cannot: it is never the fallback a
 * missing capability drops into, because an unbounded workspace lets one
 * worker fill the host out from under every other session on the daemon.
 */
export type WorkspaceQuota =
  | { mode: "enforced"; sizeBytes: number }
  | { mode: "off" };

export type LocalDockerBackendConfig = {
  /** Only networks in this list may be used; the empty list means none. */
  allowedNetworks: string[];
  apiVersion: string;
  /** Overrides the image entrypoint; tests use it to run a sleeping busybox. */
  command?: string[];
  dockerHost: string;
  /**
   * The forward proxy that is the worker network's only route off itself.
   * Handed to the worker as `HTTP_PROXY`/`HTTPS_PROXY`; the destination
   * allowlist lives in the proxy, not here.
   */
  egressProxyUrl: string;
  /** Handed to the worker as `WORKER_GATEWAY_URL`. */
  gatewayUrl: string;
  /** Mounted as tmpfs so the read-only rootfs still has a writable HOME. */
  homeDir: string;
  /**
   * Identifies this control host on a daemon shared with other installations
   * (another database, another environment). Only containers carrying the
   * same id are ever listed, adopted or reaped.
   */
  installationId: string;
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
  /**
   * How long a workspace volume must have existed before GC will consider
   * it. A volume is created before the container that mounts it and before
   * anything records the session, so a young orphan is more likely a launch
   * in flight than one to reclaim.
   */
  workspaceGcMinAgeMs: number;
  workspaceQuota: WorkspaceQuota;
};

/** Shaped like the process environment so it can be passed straight through. */
export type LocalDockerBackendEnvironment = {
  DOCKER_API_VERSION?: string | undefined;
  DOCKER_HOST?: string | undefined;
  /** Whitespace-separated entrypoint override, e.g. `sleep 600` for tests. */
  EXECUTION_DOCKER_COMMAND?: string | undefined;
  EXECUTION_DOCKER_HOME_DIR?: string | undefined;
  EXECUTION_EGRESS_PROXY_URL?: string | undefined;
  EXECUTION_INSTALLATION_ID?: string | undefined;
  EXECUTION_DOCKER_NETWORK?: string | undefined;
  EXECUTION_DOCKER_NETWORK_ALLOWLIST?: string | undefined;
  EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC?: string | undefined;
  EXECUTION_DOCKER_STOP_TIMEOUT_SEC?: string | undefined;
  EXECUTION_DOCKER_TMPFS_SIZE_MB?: string | undefined;
  EXECUTION_DOCKER_USER?: string | undefined;
  EXECUTION_DOCKER_WORKSPACE_DIR?: string | undefined;
  EXECUTION_WORKSPACE_GC_MIN_AGE_SEC?: string | undefined;
  /** `on` (default) or `off`; anything else is a typo, not an opt-out. */
  EXECUTION_WORKSPACE_QUOTA?: string | undefined;
  EXECUTION_WORKSPACE_QUOTA_MB?: string | undefined;
  WORKER_GATEWAY_URL?: string | undefined;
  [key: string]: string | undefined;
};

export const DEFAULT_WORKER_USER = "1000:1000";
export const DEFAULT_INSTALLATION_ID = "local";
const INSTALLATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
/**
 * Not `bridge`: a worker must sit on a network with no route off the daemon,
 * with the egress proxy as its only peer that has one.
 */
export const DEFAULT_WORKER_NETWORK = "agent-platform-worker";
/** Networks that can never satisfy the isolation contract, whatever the allowlist says. */
const NEVER_ALLOWED_NETWORKS = new Set(["bridge", "default", "host", "none"]);

export function localDockerConfigFromEnv(
  environment: LocalDockerBackendEnvironment,
): LocalDockerBackendConfig {
  const gatewayUrl = environment.WORKER_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("WORKER_GATEWAY_URL is required");
  const egressProxyUrl = environment.EXECUTION_EGRESS_PROXY_URL;
  if (!egressProxyUrl) {
    throw new Error("EXECUTION_EGRESS_PROXY_URL is required");
  }
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
    egressProxyUrl,
    gatewayUrl,
    homeDir: environment.EXECUTION_DOCKER_HOME_DIR ?? "/home/worker",
    installationId:
      environment.EXECUTION_INSTALLATION_ID ?? DEFAULT_INSTALLATION_ID,
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
    // Zero is a real setting — reclaim as soon as the session is finished —
    // so this one is not a `positiveInteger`.
    workspaceGcMinAgeMs:
      nonNegativeInteger(
        environment.EXECUTION_WORKSPACE_GC_MIN_AGE_SEC ??
          String(DEFAULT_WORKSPACE_GC_MIN_AGE_SEC),
        "EXECUTION_WORKSPACE_GC_MIN_AGE_SEC",
      ) * 1_000,
    workspaceQuota: workspaceQuotaFromEnv(environment),
  });
}

export const DEFAULT_WORKSPACE_QUOTA_MB = 4096;
export const DEFAULT_WORKSPACE_GC_MIN_AGE_SEC = 3600;

function workspaceQuotaFromEnv(
  environment: LocalDockerBackendEnvironment,
): WorkspaceQuota {
  const mode = environment.EXECUTION_WORKSPACE_QUOTA ?? "on";
  if (mode === "off") return { mode: "off" };
  if (mode !== "on") {
    // A misspelt value must not read as an opt-out, and must not read as
    // "enforced" either — either way the operator did not get what they typed.
    throw new Error(
      `EXECUTION_WORKSPACE_QUOTA ${mode} must be "on" or "off"; "off" is the explicit opt-out`,
    );
  }
  return {
    mode: "enforced",
    sizeBytes:
      positiveInteger(
        environment.EXECUTION_WORKSPACE_QUOTA_MB ??
          String(DEFAULT_WORKSPACE_QUOTA_MB),
        "EXECUTION_WORKSPACE_QUOTA_MB",
      ) *
      1024 *
      1024,
  };
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
  if (NEVER_ALLOWED_NETWORKS.has(config.network)) {
    throw new Error(
      `Docker network ${config.network} is never allowed for workers; use a dedicated internal network`,
    );
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
  if (!INSTALLATION_ID.test(config.installationId)) {
    throw new Error(
      `EXECUTION_INSTALLATION_ID ${config.installationId} must be a short label-safe id`,
    );
  }
  try {
    new URL(config.gatewayUrl);
  } catch {
    throw new Error(`WORKER_GATEWAY_URL ${config.gatewayUrl} is not a URL`);
  }
  // Proxies are addressed over http even when they tunnel TLS, and every
  // HTTP client reads the variable that way.
  let proxy: URL;
  try {
    proxy = new URL(config.egressProxyUrl);
  } catch {
    throw new Error(
      `EXECUTION_EGRESS_PROXY_URL ${config.egressProxyUrl} is not a URL`,
    );
  }
  if (proxy.protocol !== "http:") {
    throw new Error(
      `EXECUTION_EGRESS_PROXY_URL ${config.egressProxyUrl} must be an http:// URL`,
    );
  }
  if (
    config.workspaceQuota.mode === "enforced" &&
    (!Number.isInteger(config.workspaceQuota.sizeBytes) ||
      config.workspaceQuota.sizeBytes < 1)
  ) {
    throw new Error(
      `Workspace quota ${config.workspaceQuota.sizeBytes} is not a positive byte limit`,
    );
  }
  if (
    !Number.isInteger(config.workspaceGcMinAgeMs) ||
    config.workspaceGcMinAgeMs < 0
  ) {
    throw new Error("workspaceGcMinAgeMs must be a non-negative integer");
  }
  return config;
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
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
