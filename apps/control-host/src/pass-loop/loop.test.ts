import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import { checkHealth, judgeHealth, readStatus } from "./health.ts";
import {
  PASS_DEGRADED_EXIT,
  PASS_LOOP_ROLES,
  PASS_SKIPPED_EXIT,
  type PassLoopConfig,
  type PassStatus,
  passLoopConfigFromEnv,
  runPassLoop,
} from "./loop.ts";

const RECONCILER = PASS_LOOP_ROLES.reconciler;
const SCHEDULER = PASS_LOOP_ROLES.scheduler;

const bun = (script: string) => [process.execPath, "-e", script];
const HANGS = bun("await Bun.sleep(60_000)");
const IGNORES_SIGTERM = bun(
  "process.on('SIGTERM', () => {}); await Bun.sleep(60_000)",
);
const SUCCEEDS = bun("process.exit(0)");
const FAILS = bun("process.exit(3)");
const SKIPS = bun(`process.exit(${PASS_SKIPPED_EXIT})`);
const DEGRADES = bun(`process.exit(${PASS_DEGRADED_EXIT})`);
/** Exits with `codes[n]` on its nth run, counted in `file`; 0 past the end. */
const exitsInTurn = (file: string, codes: readonly number[]) =>
  bun(
    `const f = ${JSON.stringify(file)}; const n = Number(await Bun.file(f).text().catch(() => "0")); await Bun.write(f, String(n + 1)); process.exit(${JSON.stringify(codes)}[n] ?? 0)`,
  );

describe("pass loop", () => {
  let dir: string;
  let config: PassLoopConfig;
  let sink: MemoryLogSink;
  let logger: StructuredLogger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pass-loop-"));
    config = {
      intervalMs: 10,
      // Room for a loaded machine to start bun; the hang tests cut it.
      passTimeoutMs: 10_000,
      killGraceMs: 300,
      maxConsecutiveFailures: 2,
      statusFile: join(dir, "status.json"),
    };
    sink = new MemoryLogSink();
    logger = new StructuredLogger({ sinks: [sink] });
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const messages = () => sink.records.map((record) => record.message);

  test("a pass that hangs is killed at its deadline, counted as failed, and ends the loop once failures run out", async () => {
    const started = performance.now();
    const code = await runPassLoop({
      name: "Test",
      command: HANGS,
      config: { ...config, passTimeoutMs: 300 },
      logger,
    });
    const elapsed = performance.now() - started;

    expect(code).toBe(1);
    // Two passes, each cut at its 300ms deadline rather than left to sleep.
    expect(elapsed).toBeLessThan(5_000);
    const status = await readStatus(config.statusFile);
    expect(status).toMatchObject({
      passes: 2,
      consecutiveFailures: 2,
      lastSuccessAt: null,
      lastFailureReason: "pass did not finish within 0.3s and was killed",
    });
    expect(messages()).toEqual([
      "Test pass failed",
      "Test pass failed",
      "Test giving up after consecutive failed passes",
    ]);
    // A loop that never finished a pass is not healthy.
    expect(judgeHealth(status, new Date(), 60_000).healthy).toBe(false);
  }, 30_000);

  test("a pass that ignores SIGTERM is killed after the grace period", async () => {
    const started = performance.now();
    const code = await runPassLoop({
      name: "Test",
      command: IGNORES_SIGTERM,
      // Long enough for the child to install its handler before SIGTERM.
      config: {
        ...config,
        passTimeoutMs: 1_500,
        killGraceMs: 500,
        maxConsecutiveFailures: 1,
      },
      logger,
    });
    expect(code).toBe(1);
    // SIGTERM did nothing; the pass ended only when the grace ran out.
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_950);
    expect(await readStatus(config.statusFile)).toMatchObject({
      passes: 1,
      lastFailureReason: "pass did not finish within 1.5s and was killed",
    });
  }, 30_000);

  test("a success resets the failure count and refreshes health; a stuck loop then goes stale", async () => {
    const controller = new AbortController();
    let passes = 0;
    const loop = runPassLoop({
      name: "Test",
      command: SUCCEEDS,
      config: { ...config, maxConsecutiveFailures: 1 },
      logger: {
        info(message, fields) {
          logger.info(message, fields);
          passes += 1;
          if (passes === 3) controller.abort();
        },
        warn: (message, fields) => logger.warn(message, fields),
        error: (message, fields) => logger.error(message, fields),
      },
      signal: controller.signal,
    });
    expect(await loop).toBe(0);
    const status = await readStatus(config.statusFile);
    expect(status).toMatchObject({
      passes: 3,
      consecutiveFailures: 0,
      lastFailureAt: null,
    });
    expect(status?.lastSuccessAt).not.toBeNull();
    const lastSuccess = Date.parse(status?.lastSuccessAt ?? "");
    expect(judgeHealth(status, new Date(lastSuccess + 1_000), 5_000)).toEqual({
      healthy: true,
      reason: "last successful pass 1s ago",
    });
    // No pass since: past the stale window the same status is unhealthy.
    expect(
      judgeHealth(status, new Date(lastSuccess + 6_000), 5_000).healthy,
    ).toBe(false);
  }, 30_000);

  test("every pass gets the loop's extra environment on top of its own", async () => {
    const controller = new AbortController();
    const code = await runPassLoop({
      name: "Test",
      command: bun(
        "process.exit(process.env.PASS_EXTRA === 'yes' && process.env.PATH ? 0 : 3)",
      ),
      env: { PASS_EXTRA: "yes" },
      config: { ...config, maxConsecutiveFailures: 1 },
      logger: {
        info: () => controller.abort(),
        warn: (message, fields) => logger.warn(message, fields),
        error: (message, fields) => logger.error(message, fields),
      },
      signal: controller.signal,
    });
    expect(code).toBe(0);
  }, 30_000);

  test("failures below the limit are retried on the next pass", async () => {
    const controller = new AbortController();
    let run = 0;
    const code = await runPassLoop({
      name: "Test",
      // Fail, fail, then succeed: the limit of three is never reached.
      command: bun(
        `const f = ${JSON.stringify(join(dir, "count"))}; const n = Number(await Bun.file(f).text().catch(() => "0")) + 1; await Bun.write(f, String(n)); process.exit(n < 3 ? 3 : 0)`,
      ),
      config: { ...config, maxConsecutiveFailures: 3 },
      logger: {
        info(message, fields) {
          logger.info(message, fields);
          controller.abort();
        },
        warn: (message, fields) => logger.warn(message, fields),
        error(message, fields) {
          logger.error(message, fields);
          run += 1;
        },
      },
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(run).toBe(2);
    expect(messages()).toEqual([
      "Test pass failed",
      "Test pass failed",
      "Test pass completed",
    ]);
    expect(await readStatus(config.statusFile)).toMatchObject({
      consecutiveFailures: 0,
      lastFailureReason: "pass exited with code 3",
      passes: 3,
    });
  }, 30_000);

  test("a stop that arrives just before a pass starts does not start it", async () => {
    const controller = new AbortController();
    let clock = 0;
    const started = performance.now();
    const loop = runPassLoop({
      name: "Test",
      command: HANGS,
      config,
      logger,
      signal: controller.signal,
      // The first call stamps loopStartedAt; the second is the pass
      // deadline, taken after the loop's own stop check.
      now: () => {
        clock += 1;
        if (clock === 2) controller.abort();
        return new Date();
      },
    });
    expect(await loop).toBe(0);
    expect(performance.now() - started).toBeLessThan(config.passTimeoutMs);
    expect(await readStatus(config.statusFile)).toMatchObject({ passes: 0 });
  }, 30_000);

  test("shutdown stops a running pass without recording it either way", async () => {
    const controller = new AbortController();
    const loop = runPassLoop({
      name: "Test",
      command: HANGS,
      config,
      logger,
      signal: controller.signal,
    });
    await Bun.sleep(200);
    controller.abort();
    expect(await loop).toBe(0);
    expect(await readStatus(config.statusFile)).toMatchObject({
      passes: 0,
      lastFailureAt: null,
    });
    expect(messages()).toEqual([]);
  }, 30_000);

  test("a pass that hangs right after a success is unhealthy from its deadline on, not only once the success goes stale", async () => {
    const loop = runPassLoop({
      name: "Test",
      // Succeeds once, then hangs.
      command: bun(
        `const f = ${JSON.stringify(join(dir, "count"))}; const n = Number(await Bun.file(f).text().catch(() => "0")) + 1; await Bun.write(f, String(n)); if (n > 1) await Bun.sleep(60_000)`,
      ),
      config: {
        ...config,
        passTimeoutMs: 2_000,
        killGraceMs: 300,
        maxConsecutiveFailures: 1,
      },
      logger,
    });
    const hanging = await waitForStatus(
      (status) =>
        status.lastSuccessAt !== null && status.passDeadlineAt !== null,
    );
    const deadline = Date.parse(hanging.passDeadlineAt ?? "");
    const staleMs = 60_000;
    expect(
      judgeHealth(hanging, new Date(deadline - 1_000), staleMs).healthy,
    ).toBe(true);
    expect(judgeHealth(hanging, new Date(deadline + 1), staleMs)).toEqual({
      healthy: false,
      reason: `a pass has been running past its deadline of ${hanging.passDeadlineAt}`,
    });

    expect(await loop).toBe(1);
    // Killed and recorded: still unhealthy, with the last success fresh.
    const killed = await readStatus(config.statusFile);
    expect(killed?.passDeadlineAt).toBeNull();
    expect(judgeHealth(killed, new Date(), staleMs)).toEqual({
      healthy: false,
      reason:
        "1 failed pass(es) since the last completed one: pass did not finish within 2s and was killed",
    });
  }, 30_000);

  async function waitForStatus(
    ready: (status: PassStatus) => boolean,
  ): Promise<PassStatus> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await readStatus(config.statusFile);
      if (status !== null && ready(status)) return status;
      await Bun.sleep(25);
    }
    throw new Error("status never reached the expected state");
  }

  test("a pass that exits non-zero is a failure with its exit code", async () => {
    const code = await runPassLoop({
      name: "Test",
      command: FAILS,
      config: { ...config, maxConsecutiveFailures: 1 },
      logger,
    });
    expect(code).toBe(1);
    expect(await readStatus(config.statusFile)).toMatchObject({
      lastFailureReason: "pass exited with code 3",
    });
  }, 30_000);

  test("the healthcheck reads the status file the loop writes", async () => {
    const environment = {
      RECONCILER_STATUS_FILE: config.statusFile,
      RECONCILER_HEALTH_STALE_SEC: "5",
    };
    expect((await checkHealth(environment, RECONCILER)).healthy).toBe(false);
    const controller = new AbortController();
    await runPassLoop({
      name: "Test",
      command: SUCCEEDS,
      config,
      logger: {
        info: () => controller.abort(),
        warn: () => {},
        error: () => {},
      },
      signal: controller.signal,
    });
    expect((await checkHealth(environment, RECONCILER)).healthy).toBe(true);
    expect(
      (
        await checkHealth(
          environment,
          RECONCILER,
          new Date(Date.now() + 10_000),
        )
      ).healthy,
    ).toBe(false);
    // Another role's settings do not reach this file.
    expect(
      (
        await checkHealth(
          { SCHEDULER_STATUS_FILE: join(dir, "missing.json") },
          SCHEDULER,
        )
      ).healthy,
    ).toBe(false);
  }, 30_000);

  test("a skipped pass is neither a success nor a failure", async () => {
    const controller = new AbortController();
    let passes = 0;
    const code = await runPassLoop({
      name: "Test",
      command: SKIPS,
      config: { ...config, maxConsecutiveFailures: 1 },
      logger: {
        info: (message, fields) => logger.info(message, fields),
        warn(message, fields) {
          logger.warn(message, fields);
          passes += 1;
          if (passes === 3) controller.abort();
        },
        error: (message, fields) => logger.error(message, fields),
      },
      signal: controller.signal,
    });
    // Three skips and a failure limit of one: skips never count toward it.
    expect(code).toBe(0);
    const status = await readStatus(config.statusFile);
    expect(status).toMatchObject({
      passes: 3,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    expect(status?.lastSkippedAt).not.toBeNull();
    expect(messages()).toEqual([
      "Test pass skipped; another pass holds the lock",
      "Test pass skipped; another pass holds the lock",
      "Test pass skipped; another pass holds the lock",
    ]);
    // A loop that only ever skips has done nothing, and is not healthy.
    expect(judgeHealth(status, new Date(), 60_000)).toEqual({
      healthy: false,
      reason: `no pass has completed since ${status?.loopStartedAt}`,
    });
  }, 30_000);
});

describe("pass loop: degraded passes (94S-368)", () => {
  let dir: string;
  let sink: MemoryLogSink;
  let logger: StructuredLogger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pass-loop-degraded-"));
    sink = new MemoryLogSink();
    logger = new StructuredLogger({ sinks: [sink] });
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const config = (maxConsecutiveFailures: number): PassLoopConfig => ({
    intervalMs: 10,
    passTimeoutMs: 10_000,
    killGraceMs: 300,
    maxConsecutiveFailures,
    statusFile: join(dir, "status.json"),
  });
  const messages = () => sink.records.map((record) => record.message);

  /** Runs until `passes` passes have logged, then stops the loop. */
  function runFor(
    command: readonly string[],
    maxConsecutiveFailures: number,
    passes: number,
  ): Promise<number> {
    const controller = new AbortController();
    const count = () => {
      if (
        sink.records.filter((r) => r.message.includes(" pass ")).length >=
        passes
      ) {
        controller.abort();
      }
    };
    return runPassLoop({
      name: "Test",
      command,
      config: config(maxConsecutiveFailures),
      logger: {
        info(message, fields) {
          logger.info(message, fields);
          count();
        },
        warn(message, fields) {
          logger.warn(message, fields);
          count();
        },
        error(message, fields) {
          logger.error(message, fields);
          count();
        },
      },
      signal: controller.signal,
    });
  }

  test("degraded passes never add up to giving up, and keep the loop healthy while saying so", async () => {
    // Five degraded passes against a failure limit of one.
    expect(await runFor(DEGRADES, 1, 5)).toBe(0);
    const status = await readStatus(join(dir, "status.json"));
    expect(status).toMatchObject({
      passes: 5,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    expect(messages()).toEqual(Array(5).fill("Test pass completed degraded"));
    const lastDegraded = Date.parse(status?.lastDegradedAt ?? "");
    expect(judgeHealth(status, new Date(lastDegraded + 1_000), 5_000)).toEqual({
      healthy: true,
      reason: "last pass 1s ago completed degraded",
    });
    // Degraded passes that stopped coming go stale like successes do.
    expect(judgeHealth(status, new Date(lastDegraded + 6_000), 5_000)).toEqual({
      healthy: false,
      reason: "last pass 6s ago completed degraded",
    });
  }, 30_000);

  test("a degraded pass ends a run of failures", async () => {
    // With a limit of three, fail-fail-degraded-fail-fail never reaches it;
    // without the reset the fourth pass would be the third failure in a row.
    const command = exitsInTurn(join(dir, "count"), [
      3,
      3,
      PASS_DEGRADED_EXIT,
      3,
      3,
      PASS_DEGRADED_EXIT,
    ]);
    expect(await runFor(command, 3, 6)).toBe(0);
    expect(messages()).toEqual([
      "Test pass failed",
      "Test pass failed",
      "Test pass completed degraded",
      "Test pass failed",
      "Test pass failed",
      "Test pass completed degraded",
    ]);
    expect(await readStatus(join(dir, "status.json"))).toMatchObject({
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureReason: "pass exited with code 3",
    });
  }, 30_000);

  test("lastSuccessAt means a clean pass only; health reports whichever came last", async () => {
    const command = exitsInTurn(join(dir, "count"), [0, PASS_DEGRADED_EXIT]);
    expect(await runFor(command, 1, 2)).toBe(0);
    const status = await readStatus(join(dir, "status.json"));
    const success = Date.parse(status?.lastSuccessAt ?? "");
    const degraded = Date.parse(status?.lastDegradedAt ?? "");
    expect(degraded).toBeGreaterThanOrEqual(success);
    expect(judgeHealth(status, new Date(degraded), 60_000)).toEqual({
      healthy: true,
      reason: "last pass 0s ago completed degraded",
    });
    // A clean pass after it is reported as one.
    const clean = {
      ...status,
      lastSuccessAt: new Date(degraded + 1).toISOString(),
    } as PassStatus;
    expect(judgeHealth(clean, new Date(degraded + 1), 60_000)).toEqual({
      healthy: true,
      reason: "last successful pass 0s ago",
    });
  }, 30_000);

  test("a failure or a pass past its deadline after a degraded pass is unhealthy", () => {
    const at = Date.parse("2026-09-24T00:00:00.000Z");
    const degraded: PassStatus = {
      loopStartedAt: new Date(at - 60_000).toISOString(),
      passes: 3,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      lastSkippedAt: null,
      lastDegradedAt: new Date(at).toISOString(),
      lastPassDurationMs: 10,
      consecutiveFailures: 0,
      passDeadlineAt: null,
    };
    expect(judgeHealth(degraded, new Date(at + 1_000), 60_000).healthy).toBe(
      true,
    );
    expect(
      judgeHealth(
        {
          ...degraded,
          consecutiveFailures: 1,
          lastFailureAt: new Date(at + 5_000).toISOString(),
          lastFailureReason: "pass exited with code 1",
        },
        new Date(at + 6_000),
        60_000,
      ),
    ).toEqual({
      healthy: false,
      reason:
        "1 failed pass(es) since the last completed one: pass exited with code 1",
    });
    const deadline = new Date(at + 5_000).toISOString();
    expect(
      judgeHealth(
        { ...degraded, passDeadlineAt: deadline },
        new Date(at + 6_000),
        60_000,
      ),
    ).toEqual({
      healthy: false,
      reason: `a pass has been running past its deadline of ${deadline}`,
    });
  });
});

describe("pass loop configuration", () => {
  test("defaults: the reconciler keeps 94S-320's", () => {
    expect(passLoopConfigFromEnv({}, RECONCILER)).toEqual({
      intervalMs: 10_000,
      passTimeoutMs: 60_000,
      killGraceMs: 10_000,
      maxConsecutiveFailures: 3,
      statusFile: "/tmp/reconciler-status.json",
    });
  });

  test("defaults: the scheduler's", () => {
    expect(passLoopConfigFromEnv({}, SCHEDULER)).toEqual({
      intervalMs: 5_000,
      passTimeoutMs: 180_000,
      killGraceMs: 30_000,
      maxConsecutiveFailures: 3,
      statusFile: "/tmp/scheduler-status.json",
    });
  });

  test("each role reads only its own prefix", () => {
    const environment = {
      RECONCILER_INTERVAL_SEC: "20",
      SCHEDULER_INTERVAL_SEC: "7",
      SCHEDULER_STATUS_FILE: "/run/scheduler.json",
    };
    expect(passLoopConfigFromEnv(environment, RECONCILER)).toMatchObject({
      intervalMs: 20_000,
      statusFile: "/tmp/reconciler-status.json",
    });
    expect(passLoopConfigFromEnv(environment, SCHEDULER)).toMatchObject({
      intervalMs: 7_000,
      statusFile: "/run/scheduler.json",
    });
  });

  test("reads every setting from the environment", () => {
    expect(
      passLoopConfigFromEnv(
        {
          RECONCILER_INTERVAL_SEC: "30",
          RECONCILER_PASS_TIMEOUT_SEC: "90",
          RECONCILER_MAX_CONSECUTIVE_FAILURES: "5",
          RECONCILER_HEALTH_STALE_SEC: "180",
          RECONCILER_STATUS_FILE: "/run/status.json",
        },
        RECONCILER,
      ),
    ).toEqual({
      intervalMs: 30_000,
      passTimeoutMs: 90_000,
      killGraceMs: 10_000,
      maxConsecutiveFailures: 5,
      statusFile: "/run/status.json",
    });
  });

  test("refuses values that are not positive integers", () => {
    for (const RECONCILER_INTERVAL_SEC of ["0", "-1", "1.5", "ten"]) {
      expect(() =>
        passLoopConfigFromEnv({ RECONCILER_INTERVAL_SEC }, RECONCILER),
      ).toThrow("RECONCILER_INTERVAL_SEC must be a positive integer");
    }
    expect(() =>
      passLoopConfigFromEnv({ RECONCILER_PASS_TIMEOUT_SEC: "0" }, RECONCILER),
    ).toThrow("RECONCILER_PASS_TIMEOUT_SEC must be a positive integer");
  });

  test("refuses a stale window that every healthy loop would fall outside", () => {
    expect(() =>
      passLoopConfigFromEnv(
        { RECONCILER_INTERVAL_SEC: "30", RECONCILER_HEALTH_STALE_SEC: "90" },
        RECONCILER,
      ),
    ).toThrow(
      "RECONCILER_HEALTH_STALE_SEC must be greater than RECONCILER_INTERVAL_SEC + RECONCILER_PASS_TIMEOUT_SEC",
    );
    expect(() =>
      passLoopConfigFromEnv({ SCHEDULER_HEALTH_STALE_SEC: "60" }, SCHEDULER),
    ).toThrow(
      "SCHEDULER_HEALTH_STALE_SEC must be greater than SCHEDULER_INTERVAL_SEC + SCHEDULER_PASS_TIMEOUT_SEC",
    );
  });
});
