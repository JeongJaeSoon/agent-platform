import { rename, writeFile } from "node:fs/promises";

/**
 * Runs a role one pass per child process, forever (94S-320, 94S-117). The
 * pass (`main.ts <role> --once`) keeps its one-shot contract; this loop is
 * what turns it into a service: a pass that hangs is stopped and counted as a
 * failure, a run of failures ends the process so the restart policy engages,
 * and every pass leaves its outcome in a status file the healthcheck
 * (`health.ts`) reads. A child per pass rather than a call in-process,
 * because only a process can be killed whatever it is stuck in, and a fresh
 * pool per pass is what each pass already promises. Passes never overlap:
 * the next starts after the last one has exited, killed or not.
 */

export type PassLoopConfig = {
  intervalMs: number;
  passTimeoutMs: number;
  // SIGTERM asks a pass to stop at its next safe point; SIGKILL after this.
  killGraceMs: number;
  maxConsecutiveFailures: number;
  statusFile: string;
};

/** One role's defaults; its settings are read from `${prefix}_*`. */
export type PassLoopRole = {
  prefix: string;
  intervalSec: number;
  passTimeoutSec: number;
  maxConsecutiveFailures: number;
  healthStaleSec: number;
  stopGraceSec: number;
  statusFile: string;
};

export const PASS_LOOP_ROLES = {
  // 94S-320's settings and status file, kept as they were.
  reconciler: {
    prefix: "RECONCILER",
    intervalSec: 10,
    // Above the ~45s a frozen database takes to fail a pass on its own
    // (JOB_POOL_TIMEOUTS); this is the watchdog for everything else.
    passTimeoutSec: 60,
    maxConsecutiveFailures: 3,
    healthStaleSec: 90,
    // Every write is a transaction re-judged under row locks, so a pass
    // ended anywhere loses nothing; the grace only lets it roll back.
    stopGraceSec: 10,
    statusFile: "/tmp/reconciler-status.json",
  },
  scheduler: {
    prefix: "SCHEDULER",
    intervalSec: 5,
    passTimeoutSec: 120,
    maxConsecutiveFailures: 3,
    healthStaleSec: 140,
    // A stopped pass finishes the Docker call it is in (each bounded by the
    // backend's own timeouts) and stops before the next reservation.
    stopGraceSec: 30,
    statusFile: "/tmp/scheduler-status.json",
  },
} as const satisfies Record<string, PassLoopRole>;

export type PassLoopRoleName = keyof typeof PASS_LOOP_ROLES;

/**
 * A pass that found nothing it may do (another pass holds the scheduler's
 * lock) exits with this: neither a success, which would keep a blocked loop
 * looking healthy, nor a failure, which would restart a loop that is fine.
 * EX_TEMPFAIL from sysexits.h.
 */
export const PASS_SKIPPED_EXIT = 75;

export type PassLoopEnvironment = Readonly<Record<string, string | undefined>>;

export function passLoopConfigFromEnv(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
): PassLoopConfig {
  const intervalSec = setting(environment, role, "INTERVAL_SEC");
  const passTimeoutSec = setting(environment, role, "PASS_TIMEOUT_SEC");
  const maxConsecutiveFailures = setting(
    environment,
    role,
    "MAX_CONSECUTIVE_FAILURES",
  );
  const healthStaleSec = healthStaleSecFromEnv(environment, role);
  // Two successes can be a full pass apart plus the interval; a window no
  // longer than that reads a healthy loop as stale between them.
  if (healthStaleSec <= intervalSec + passTimeoutSec) {
    const name = (suffix: string) => `${role.prefix}_${suffix}`;
    throw new Error(
      `${name("HEALTH_STALE_SEC")} must be greater than ${name("INTERVAL_SEC")} + ${name("PASS_TIMEOUT_SEC")}`,
    );
  }
  return {
    intervalMs: intervalSec * 1000,
    passTimeoutMs: passTimeoutSec * 1000,
    killGraceMs: role.stopGraceSec * 1000,
    maxConsecutiveFailures,
    statusFile: statusFileFromEnv(environment, role),
  };
}

export function healthStaleSecFromEnv(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
): number {
  return setting(environment, role, "HEALTH_STALE_SEC");
}

export function statusFileFromEnv(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
): string {
  return environment[`${role.prefix}_STATUS_FILE`] ?? role.statusFile;
}

const DEFAULTS = {
  INTERVAL_SEC: "intervalSec",
  PASS_TIMEOUT_SEC: "passTimeoutSec",
  MAX_CONSECUTIVE_FAILURES: "maxConsecutiveFailures",
  HEALTH_STALE_SEC: "healthStaleSec",
} as const;

function setting(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
  suffix: keyof typeof DEFAULTS,
): number {
  const name = `${role.prefix}_${suffix}`;
  return positiveInteger(
    environment[name] ?? String(role[DEFAULTS[suffix]]),
    name,
  );
}

/** What the last passes did; the healthcheck and an operator read it. */
export type PassStatus = {
  loopStartedAt: string;
  passes: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastSkippedAt: string | null;
  lastPassDurationMs: number | null;
  consecutiveFailures: number;
  // Set while a pass runs: past it, the pass is stuck until the kill lands.
  passDeadlineAt: string | null;
};

export type PassLoopLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

type PassOutcome =
  | { outcome: "succeeded" }
  | { outcome: "skipped" }
  | { outcome: "failed"; reason: string };

/**
 * Resolves with the process exit code: 1 once `maxConsecutiveFailures`
 * passes in a row failed, 0 when `signal` stopped the loop. On `signal` no
 * new pass starts and the running one is asked to stop (SIGTERM), then
 * killed once `killGraceMs` has passed.
 */
export async function runPassLoop(input: {
  name: string;
  command: readonly string[];
  config: PassLoopConfig;
  logger: PassLoopLogger;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<number> {
  const { name, command, config, logger, signal } = input;
  const now = input.now ?? (() => new Date());
  const status: PassStatus = {
    loopStartedAt: now().toISOString(),
    passes: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    lastSkippedAt: null,
    lastPassDurationMs: null,
    consecutiveFailures: 0,
    passDeadlineAt: null,
  };
  await writeStatus(config.statusFile, status, logger);
  while (!signal?.aborted) {
    status.passDeadlineAt = new Date(
      now().getTime() + config.passTimeoutMs,
    ).toISOString();
    await writeStatus(config.statusFile, status, logger);
    // A stop that arrived during the write must not start a pass: its abort
    // listener would be added after the event and never forward SIGTERM.
    if (signal?.aborted) break;
    const started = performance.now();
    const result = await runPass(command, config, signal);
    const durationMs = Math.round(performance.now() - started);
    // A pass cut short by shutdown is neither a success nor a failure.
    if (signal?.aborted) break;
    status.passDeadlineAt = null;
    status.passes += 1;
    status.lastPassDurationMs = durationMs;
    if (result.outcome === "succeeded") {
      status.lastSuccessAt = now().toISOString();
      status.consecutiveFailures = 0;
      logger.info(`${name} pass completed`, { duration_ms: durationMs });
    } else if (result.outcome === "skipped") {
      status.lastSkippedAt = now().toISOString();
      logger.warn(`${name} pass skipped; another pass holds the lock`, {
        duration_ms: durationMs,
      });
    } else {
      status.lastFailureAt = now().toISOString();
      status.lastFailureReason = result.reason;
      status.consecutiveFailures += 1;
      logger.error(`${name} pass failed`, {
        consecutive_failures: status.consecutiveFailures,
        duration_ms: durationMs,
        reason: result.reason,
      });
    }
    await writeStatus(config.statusFile, status, logger);
    if (status.consecutiveFailures >= config.maxConsecutiveFailures) {
      logger.error(`${name} giving up after consecutive failed passes`, {
        consecutive_failures: status.consecutiveFailures,
      });
      return 1;
    }
    await sleep(config.intervalMs, signal);
  }
  return 0;
}

async function runPass(
  command: readonly string[],
  config: PassLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PassOutcome> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), config.killGraceMs);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, config.passTimeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const code = await child.exited;
    if (timedOut) {
      return {
        outcome: "failed",
        reason: `pass did not finish within ${config.passTimeoutMs / 1000}s and was killed`,
      };
    }
    if (child.signalCode !== null) {
      return { outcome: "failed", reason: `pass ended by ${child.signalCode}` };
    }
    if (code === 0) return { outcome: "succeeded" };
    if (code === PASS_SKIPPED_EXIT) return { outcome: "skipped" };
    return { outcome: "failed", reason: `pass exited with code ${code}` };
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
  }
}

// Written aside and renamed, so the healthcheck never reads half a file.
async function writeStatus(
  path: string,
  status: PassStatus,
  logger: PassLoopLogger,
): Promise<void> {
  const staging = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify(status)}\n`);
    await rename(staging, path);
  } catch (error) {
    // No crash: a status that stops updating already fails the healthcheck.
    logger.error("Pass status file could not be written", {
      error: error instanceof Error ? error.message : String(error),
      path,
    });
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
