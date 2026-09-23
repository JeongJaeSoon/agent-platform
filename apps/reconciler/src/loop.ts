import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@agent-platform/observability";

/**
 * Runs the reconciler one pass per child process, forever (94S-320). The pass
 * itself (`main.ts`) keeps its one-shot contract; this loop is what turns it
 * into a service: a pass that hangs is killed and counted as a failure, a run
 * of failures ends the process so the restart policy engages, and every pass
 * leaves its outcome in a status file the healthcheck (`health.ts`) reads. A
 * child per pass rather than a call in-process, because only a process can be
 * killed whatever it is stuck in, and a fresh pool per pass is what `main.ts`
 * already promises. Passes never overlap: the next starts after the last one
 * has exited, killed or not.
 *
 * Nothing in `runPassLoop` is reconciler-specific: it takes the command and
 * a name for its log lines, and only the env parser below reads RECONCILER_*.
 * Moves into the control host's reconciler role with 94S-117, which is meant
 * to keep these settings and this status file as they are, and may run the
 * scheduler role under the same loop.
 */

export type PassLoopConfig = {
  intervalMs: number;
  passTimeoutMs: number;
  // SIGTERM first so a pass can end its transaction; SIGKILL after this.
  killGraceMs: number;
  maxConsecutiveFailures: number;
  statusFile: string;
};

export type PassLoopEnvironment = {
  RECONCILER_INTERVAL_SEC?: string | undefined;
  RECONCILER_PASS_TIMEOUT_SEC?: string | undefined;
  RECONCILER_MAX_CONSECUTIVE_FAILURES?: string | undefined;
  RECONCILER_HEALTH_STALE_SEC?: string | undefined;
  RECONCILER_STATUS_FILE?: string | undefined;
  // So the process environment passes as it is.
  [name: string]: string | undefined;
};

export const DEFAULT_STATUS_FILE = "/tmp/reconciler-status.json";

export function passLoopConfigFromEnv(
  environment: PassLoopEnvironment,
): PassLoopConfig {
  const intervalSec = positiveInteger(
    environment.RECONCILER_INTERVAL_SEC ?? "10",
    "RECONCILER_INTERVAL_SEC",
  );
  // Above the ~45s a frozen database takes to fail a pass on its own
  // (JOB_POOL_TIMEOUTS); this is the watchdog for everything else.
  const passTimeoutSec = positiveInteger(
    environment.RECONCILER_PASS_TIMEOUT_SEC ?? "60",
    "RECONCILER_PASS_TIMEOUT_SEC",
  );
  const maxConsecutiveFailures = positiveInteger(
    environment.RECONCILER_MAX_CONSECUTIVE_FAILURES ?? "3",
    "RECONCILER_MAX_CONSECUTIVE_FAILURES",
  );
  const healthStaleSec = healthStaleSecFromEnv(environment);
  // At or under the interval, a loop whose every pass succeeds still reads
  // as stale between two of them.
  if (healthStaleSec <= intervalSec) {
    throw new Error(
      "RECONCILER_HEALTH_STALE_SEC must be greater than RECONCILER_INTERVAL_SEC",
    );
  }
  return {
    intervalMs: intervalSec * 1000,
    passTimeoutMs: passTimeoutSec * 1000,
    killGraceMs: 10_000,
    maxConsecutiveFailures,
    statusFile: environment.RECONCILER_STATUS_FILE ?? DEFAULT_STATUS_FILE,
  };
}

export function healthStaleSecFromEnv(
  environment: PassLoopEnvironment,
): number {
  return positiveInteger(
    environment.RECONCILER_HEALTH_STALE_SEC ?? "90",
    "RECONCILER_HEALTH_STALE_SEC",
  );
}

/** What the last passes did; the healthcheck and an operator read it. */
export type PassStatus = {
  loopStartedAt: string;
  passes: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastPassDurationMs: number | null;
  consecutiveFailures: number;
};

export type PassLoopLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

/**
 * Resolves with the process exit code: 1 once `maxConsecutiveFailures`
 * passes in a row failed, 0 when `signal` stopped the loop.
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
    lastPassDurationMs: null,
    consecutiveFailures: 0,
  };
  await writeStatus(config.statusFile, status, logger);
  while (!signal?.aborted) {
    const started = performance.now();
    const failure = await runPass(command, config, signal);
    const durationMs = Math.round(performance.now() - started);
    // A pass cut short by shutdown is neither a success nor a failure.
    if (signal?.aborted) break;
    status.passes += 1;
    status.lastPassDurationMs = durationMs;
    if (failure === null) {
      status.lastSuccessAt = now().toISOString();
      status.consecutiveFailures = 0;
      logger.info(`${name} pass completed`, { duration_ms: durationMs });
    } else {
      status.lastFailureAt = now().toISOString();
      status.lastFailureReason = failure;
      status.consecutiveFailures += 1;
      logger.error(`${name} pass failed`, {
        consecutive_failures: status.consecutiveFailures,
        duration_ms: durationMs,
        reason: failure,
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

/** null on success, otherwise why the pass failed. */
async function runPass(
  command: readonly string[],
  config: PassLoopConfig,
  signal: AbortSignal | undefined,
): Promise<string | null> {
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
      return `pass did not finish within ${config.passTimeoutMs / 1000}s and was killed`;
    }
    if (code === 0) return null;
    return child.signalCode === null
      ? `pass exited with code ${code}`
      : `pass ended by ${child.signalCode}`;
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

if (import.meta.main) {
  const config = passLoopConfigFromEnv(process.env);
  const logger = createLogger(
    process.env.LOG_LEVEL === undefined ? {} : { level: process.env.LOG_LEVEL },
  );
  const shutdown = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"] as const) {
    process.on(name, () => shutdown.abort());
  }
  logger.info("Reconciler loop started", {
    interval_ms: config.intervalMs,
    max_consecutive_failures: config.maxConsecutiveFailures,
    pass_timeout_ms: config.passTimeoutMs,
    status_file: config.statusFile,
  });
  process.exitCode = await runPassLoop({
    name: "Reconciler",
    command: [process.execPath, "run", join(import.meta.dir, "main.ts")],
    config,
    logger,
    signal: shutdown.signal,
  });
}
