import type {
  PermissionMode,
  RuntimeProfile,
} from "@agent-platform/runtime-claude";

/**
 * Everything the worker reads from its environment. The first block is what
 * `LocalDockerBackend` injects (`backend.ts` `ENV`); the rest is the runtime
 * profile and the timers, which no launcher sets today.
 */
export type WorkerEnvironment = {
  HOME?: string | undefined;
  WORKER_BOOTSTRAP_NONCE?: string | undefined;
  WORKER_EXECUTION_GENERATION?: string | undefined;
  WORKER_EXECUTION_ID?: string | undefined;
  WORKER_GATEWAY_URL?: string | undefined;
  WORKER_STOP_GRACE_SEC?: string | undefined;

  WORKER_CLAUDE_CONFIG_DIR?: string | undefined;
  WORKER_MODEL?: string | undefined;
  WORKER_PERMISSION_MODE?: string | undefined;
  WORKER_RUNTIME_AUTH_KIND?: string | undefined;
  WORKER_RUNTIME_AUTH_VALUE?: string | undefined;
  WORKER_RUNTIME_ENDPOINT?: string | undefined;
  WORKER_RUNTIME_KIND?: string | undefined;
  WORKER_TOOLS?: string | undefined;
  WORKER_WORKSPACE_DIR?: string | undefined;

  WORKER_ANSWER_POLL_SEC?: string | undefined;
  WORKER_CLAIM_TIMEOUT_SEC?: string | undefined;
  WORKER_DRAIN_TIMEOUT_SEC?: string | undefined;
  WORKER_HEARTBEAT_INTERVAL_SEC?: string | undefined;
  WORKER_IDLE_TIMEOUT_SEC?: string | undefined;
  WORKER_NEXT_INPUT_WAIT_SEC?: string | undefined;
  WORKER_REQUEST_TIMEOUT_SEC?: string | undefined;
  QUESTION_TIMEOUT_SEC?: string | undefined;
};

export type WorkerTimeouts = {
  /** How often a waiting approval asks the gateway for its answer. */
  answerPollIntervalMs: number;
  /** Give up claiming a session and exit cleanly (DESIGN §6.2). */
  claimTimeoutMs: number;
  /**
   * Budget for a turn to finish on its own once SIGTERM arrived. Never more
   * than the launcher's stop grace leaves after the shutdown that follows.
   */
  drainTimeoutMs: number;
  heartbeatIntervalMs: number;
  /** Release the session and exit after this long with no input. */
  idleTimeoutMs: number;
  nextInputWaitMs: number;
  /** A pending permission or question denied once nobody has answered it. */
  questionTimeoutMs: number;
  requestTimeoutMs: number;
  /**
   * Time between SIGTERM and SIGKILL, when the launcher says (LocalDocker
   * does). Every shutdown wait fits inside it; unknown means unbounded.
   */
  stopGraceMs?: number;
};

export type WorkerRuntimeSettings = {
  claudeConfigDir: string;
  cwd: string;
  home: string;
  model: string;
  permissionMode: PermissionMode;
  profile: RuntimeProfile;
  tools: string[];
};

export type WorkerConfig = {
  bootstrapNonce: string;
  executionGeneration: number;
  executionId: string;
  gatewayUrl: string;
  runtime: WorkerRuntimeSettings;
  timeouts: WorkerTimeouts;
};

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "dontAsk",
  "plan",
]);

export function workerConfigFromEnv(
  environment: WorkerEnvironment,
): WorkerConfig {
  const home = required(environment.HOME, "HOME");
  const endpoint = required(
    environment.WORKER_RUNTIME_ENDPOINT,
    "WORKER_RUNTIME_ENDPOINT",
  );
  const authValue = required(
    environment.WORKER_RUNTIME_AUTH_VALUE,
    "WORKER_RUNTIME_AUTH_VALUE",
  );
  const stopGraceMs =
    environment.WORKER_STOP_GRACE_SEC === undefined
      ? undefined
      : seconds(environment.WORKER_STOP_GRACE_SEC, 0, "WORKER_STOP_GRACE_SEC");
  return {
    bootstrapNonce: required(
      environment.WORKER_BOOTSTRAP_NONCE,
      "WORKER_BOOTSTRAP_NONCE",
    ),
    executionGeneration: nonNegativeInteger(
      required(
        environment.WORKER_EXECUTION_GENERATION,
        "WORKER_EXECUTION_GENERATION",
      ),
      "WORKER_EXECUTION_GENERATION",
    ),
    executionId: required(
      environment.WORKER_EXECUTION_ID,
      "WORKER_EXECUTION_ID",
    ),
    gatewayUrl: url(
      required(environment.WORKER_GATEWAY_URL, "WORKER_GATEWAY_URL"),
      "WORKER_GATEWAY_URL",
    ),
    runtime: {
      claudeConfigDir:
        environment.WORKER_CLAUDE_CONFIG_DIR ?? `${home}/.claude`,
      // The backend mounts the workspace volume at its own
      // EXECUTION_DOCKER_WORKSPACE_DIR but does not tell the container where
      // that is; the two defaults have to agree until 94S-206 puts the
      // workspace descriptor in the claim response.
      cwd: environment.WORKER_WORKSPACE_DIR ?? "/workspace",
      home,
      model: required(environment.WORKER_MODEL, "WORKER_MODEL"),
      permissionMode: permissionMode(environment.WORKER_PERMISSION_MODE),
      profile: profile(environment, endpoint, authValue),
      tools: (environment.WORKER_TOOLS ?? "")
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0),
    },
    timeouts: {
      answerPollIntervalMs: seconds(
        environment.WORKER_ANSWER_POLL_SEC,
        1,
        "WORKER_ANSWER_POLL_SEC",
      ),
      claimTimeoutMs: seconds(
        environment.WORKER_CLAIM_TIMEOUT_SEC,
        60,
        "WORKER_CLAIM_TIMEOUT_SEC",
      ),
      drainTimeoutMs: drainBudget(
        seconds(
          environment.WORKER_DRAIN_TIMEOUT_SEC,
          100,
          "WORKER_DRAIN_TIMEOUT_SEC",
        ),
        stopGraceMs,
      ),
      heartbeatIntervalMs: seconds(
        environment.WORKER_HEARTBEAT_INTERVAL_SEC,
        10,
        "WORKER_HEARTBEAT_INTERVAL_SEC",
      ),
      idleTimeoutMs: seconds(
        environment.WORKER_IDLE_TIMEOUT_SEC,
        1800,
        "WORKER_IDLE_TIMEOUT_SEC",
      ),
      nextInputWaitMs: seconds(
        environment.WORKER_NEXT_INPUT_WAIT_SEC,
        20,
        "WORKER_NEXT_INPUT_WAIT_SEC",
      ),
      questionTimeoutMs: seconds(
        environment.QUESTION_TIMEOUT_SEC,
        1800,
        "QUESTION_TIMEOUT_SEC",
      ),
      requestTimeoutMs: seconds(
        environment.WORKER_REQUEST_TIMEOUT_SEC,
        30,
        "WORKER_REQUEST_TIMEOUT_SEC",
      ),
      ...(stopGraceMs === undefined ? {} : { stopGraceMs }),
    },
  };
}

function profile(
  environment: WorkerEnvironment,
  endpoint: string,
  authValue: string,
): RuntimeProfile {
  const kind = environment.WORKER_RUNTIME_KIND ?? "litellm";
  const authKind = environment.WORKER_RUNTIME_AUTH_KIND ?? "api_key";
  if (kind === "anthropic") {
    if (authKind !== "api_key") {
      throw new Error("WORKER_RUNTIME_AUTH_KIND must be api_key for anthropic");
    }
    return {
      kind: "anthropic",
      endpoint,
      auth: { kind: "api_key", value: authValue },
    };
  }
  if (kind !== "litellm") {
    throw new Error(`WORKER_RUNTIME_KIND ${kind} is not a known profile kind`);
  }
  if (authKind !== "api_key" && authKind !== "bearer") {
    throw new Error(
      `WORKER_RUNTIME_AUTH_KIND ${authKind} must be api_key or bearer`,
    );
  }
  return {
    kind: "litellm",
    endpoint,
    auth: { kind: authKind, value: authValue },
  };
}

function permissionMode(value: string | undefined): PermissionMode {
  if (value === undefined) return "default";
  if (!PERMISSION_MODES.has(value as PermissionMode)) {
    throw new Error(`WORKER_PERMISSION_MODE ${value} is not supported`);
  }
  return value as PermissionMode;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function url(value: string, name: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} ${value} is not a URL`);
  }
}

/**
 * What a drain may spend once the rest of the shutdown is paid for: the
 * interrupt grace, the engine exit grace and the release after them. A grace
 * too short for any of that leaves no drain at all — the turn in flight is
 * interrupted at once and left for the recovery path to retry.
 */
export const SHUTDOWN_RESERVE_MS = 12_000;

function drainBudget(configured: number, stopGraceMs: number | undefined) {
  if (stopGraceMs === undefined) return configured;
  return Math.min(configured, Math.max(0, stopGraceMs - SHUTDOWN_RESERVE_MS));
}

function seconds(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number of seconds`);
  }
  return Math.round(parsed * 1000);
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
