import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import { checkHealth, judgeHealth, readStatus } from "./health.ts";
import {
  type PassLoopConfig,
  passLoopConfigFromEnv,
  runPassLoop,
} from "./loop.ts";

const bun = (script: string) => [process.execPath, "-e", script];
const HANGS = bun("await Bun.sleep(60_000)");
const IGNORES_SIGTERM = bun(
  "process.on('SIGTERM', () => {}); await Bun.sleep(60_000)",
);
const SUCCEEDS = bun("process.exit(0)");
const FAILS = bun("process.exit(3)");

describe("pass loop", () => {
  let dir: string;
  let config: PassLoopConfig;
  let sink: MemoryLogSink;
  let logger: StructuredLogger;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reconciler-loop-"));
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
    expect((await checkHealth(environment)).healthy).toBe(false);
    const controller = new AbortController();
    await runPassLoop({
      name: "Test",
      command: SUCCEEDS,
      config,
      logger: {
        info: () => controller.abort(),
        error: () => {},
      },
      signal: controller.signal,
    });
    expect((await checkHealth(environment)).healthy).toBe(true);
    expect(
      (await checkHealth(environment, new Date(Date.now() + 10_000))).healthy,
    ).toBe(false);
  }, 30_000);
});

describe("pass loop configuration", () => {
  test("defaults", () => {
    expect(passLoopConfigFromEnv({})).toEqual({
      intervalMs: 10_000,
      passTimeoutMs: 60_000,
      killGraceMs: 10_000,
      maxConsecutiveFailures: 3,
      statusFile: "/tmp/reconciler-status.json",
    });
  });

  test("reads every setting from the environment", () => {
    expect(
      passLoopConfigFromEnv({
        RECONCILER_INTERVAL_SEC: "30",
        RECONCILER_PASS_TIMEOUT_SEC: "90",
        RECONCILER_MAX_CONSECUTIVE_FAILURES: "5",
        RECONCILER_HEALTH_STALE_SEC: "180",
        RECONCILER_STATUS_FILE: "/run/status.json",
      }),
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
      expect(() => passLoopConfigFromEnv({ RECONCILER_INTERVAL_SEC })).toThrow(
        "RECONCILER_INTERVAL_SEC must be a positive integer",
      );
    }
    expect(() =>
      passLoopConfigFromEnv({ RECONCILER_PASS_TIMEOUT_SEC: "0" }),
    ).toThrow("RECONCILER_PASS_TIMEOUT_SEC must be a positive integer");
  });

  test("refuses a stale window that every healthy loop would fall outside", () => {
    expect(() =>
      passLoopConfigFromEnv({
        RECONCILER_INTERVAL_SEC: "60",
        RECONCILER_HEALTH_STALE_SEC: "60",
      }),
    ).toThrow(
      "RECONCILER_HEALTH_STALE_SEC must be greater than RECONCILER_INTERVAL_SEC",
    );
  });
});
