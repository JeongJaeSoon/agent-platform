import { describe, expect, test } from "bun:test";

import {
  SHUTDOWN_RESERVE_MS,
  type WorkerEnvironment,
  workerConfigFromEnv,
} from "./config.ts";

const launched: WorkerEnvironment = {
  HOME: "/home/worker",
  WORKER_BOOTSTRAP_NONCE: "wln_from_launch",
  WORKER_EXECUTION_GENERATION: "3",
  WORKER_EXECUTION_ID: "exec-42",
  WORKER_GATEWAY_URL: "http://control-host:8080/",
  WORKER_WORKSPACE_DIR: "/workspace",
  AWS_ACCESS_KEY_ID: "test",
  AWS_ENDPOINT_URL: "http://localstack:4566",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "test",
  S3_BUCKET: "claude-sessions",
  WORKER_OBJECT_PREFIX: "sessions/abc/",
};

describe("workerConfigFromEnv", () => {
  test("reads what the execution backend injected", () => {
    const config = workerConfigFromEnv(launched);

    expect(config).toMatchObject({
      bootstrapNonce: "wln_from_launch",
      executionGeneration: 3,
      executionId: "exec-42",
      gatewayUrl: "http://control-host:8080",
    });
    expect(config.runtime.home).toBe("/home/worker");
    expect(config.runtime.claudeConfigDir).toBe("/home/worker/.claude");
    expect(config.runtime.cwd).toBe("/workspace");
  });

  test("keeps the design's default timers", () => {
    expect(workerConfigFromEnv(launched).timeouts).toEqual({
      answerPollIntervalMs: 1_000,
      claimTimeoutMs: 60_000,
      drainTimeoutMs: 100_000,
      heartbeatIntervalMs: 10_000,
      idleTimeoutMs: 1_800_000,
      leaseSafetyMarginMs: 10_000,
      maxTurnMs: 3_600_000,
      nextInputRetryTimeoutMs: 60_000,
      nextInputWaitMs: 20_000,
      questionTimeoutMs: 1_800_000,
      requestTimeoutMs: 30_000,
      startupTimeoutMs: 3_600_000,
    });
  });

  test("fits the drain inside the launcher's stop grace", () => {
    const drain = (grace: string | undefined) =>
      workerConfigFromEnv({ ...launched, WORKER_STOP_GRACE_SEC: grace })
        .timeouts;

    // Unknown grace: the configured budget stands, and nothing is bounded.
    expect(drain(undefined).drainTimeoutMs).toBe(100_000);
    expect(drain(undefined).stopGraceMs).toBeUndefined();
    // DESIGN's 120 s leaves the whole default drain.
    expect(drain("120").drainTimeoutMs).toBe(100_000);
    expect(drain("60").drainTimeoutMs).toBe(60_000 - SHUTDOWN_RESERVE_MS);
    // LocalDocker's 10 s pays for the shutdown only: no drain at all.
    expect(drain("10")).toMatchObject({
      drainTimeoutMs: 0,
      stopGraceMs: 10_000,
    });
  });

  test.each([
    ["HOME", { HOME: undefined }],
    ["WORKER_GATEWAY_URL", { WORKER_GATEWAY_URL: undefined }],
    ["WORKER_BOOTSTRAP_NONCE", { WORKER_BOOTSTRAP_NONCE: undefined }],
    ["WORKER_EXECUTION_ID", { WORKER_EXECUTION_ID: undefined }],
    ["WORKER_WORKSPACE_DIR", { WORKER_WORKSPACE_DIR: undefined }],
    ["S3_BUCKET", { S3_BUCKET: undefined }],
    ["WORKER_OBJECT_PREFIX", { WORKER_OBJECT_PREFIX: undefined }],
  ])("refuses to start without %s", (name, missing) => {
    expect(() => workerConfigFromEnv({ ...launched, ...missing })).toThrow(
      name,
    );
  });

  test("names the setting that is wrong rather than failing later", () => {
    expect(() =>
      workerConfigFromEnv({ ...launched, WORKER_GATEWAY_URL: "not-a-url" }),
    ).toThrow("WORKER_GATEWAY_URL not-a-url is not a URL");
    expect(() =>
      workerConfigFromEnv({ ...launched, QUESTION_TIMEOUT_SEC: "0" }),
    ).toThrow("QUESTION_TIMEOUT_SEC must be a positive number of seconds");
  });
});
