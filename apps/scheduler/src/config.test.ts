import { describe, expect, test } from "bun:test";
import { schedulerConfigFromEnv } from "./config.ts";

const base = {
  AWS_ACCESS_KEY_ID: "test",
  AWS_ENDPOINT_URL: "http://localstack:4566",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "test",
  DATABASE_URL: "postgresql://postgres:dev@127.0.0.1:5432/sessions",
  EXECUTION_SLOT_LIMIT: "10",
  EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
  EXECUTION_INSTALLATION_ID: "dev-a",
  MAX_TURN_SECONDS: "3600",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  S3_BUCKET: "claude-sessions",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
  WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
  WORKER_IMAGE: "agent-platform-worker:dev",
};

describe("schedulerConfigFromEnv", () => {
  test("reads the installation limits and defaults the worker resources to the documented values", () => {
    const config = schedulerConfigFromEnv(base);
    expect(config).toMatchObject({
      databaseUrl: base.DATABASE_URL,
      image: "agent-platform-worker:dev",
      resources: {
        cpus: 1,
        memoryBytes: 2048 * 1024 * 1024,
        pidsLimit: 512,
      },
      slotLimit: 10,
    });
    expect(config.limits).toEqual({
      executionSlotLimit: 10,
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
      queuedInputLimitPerSession: 20,
      sessionCostLimitUsd: 25,
      storageLimitBytes: 1073741824,
    });
    expect(config.docker.workerLimits).toEqual({
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
    });
    expect(config.docker.gatewayUrl).toBe(base.WORKER_GATEWAY_URL);
    expect(config.docker.egressProxyUrl).toBe(base.EXECUTION_EGRESS_PROXY_URL);
  });

  test("falls back to QUEUE_DATABASE_URL and honours explicit limits", () => {
    const config = schedulerConfigFromEnv({
      ...base,
      DATABASE_URL: undefined,
      EXECUTION_SLOT_LIMIT: "3",
      QUEUE_DATABASE_URL: "postgresql://q",
      WORKER_CPUS: "0.5",
      WORKER_MEMORY_MB: "512",
      WORKER_PIDS_LIMIT: "128",
    });
    expect(config).toMatchObject({
      databaseUrl: "postgresql://q",
      resources: {
        cpus: 0.5,
        memoryBytes: 512 * 1024 * 1024,
        pidsLimit: 128,
      },
      slotLimit: 3,
    });
  });

  test("rejects missing or malformed settings by name", () => {
    expect(() =>
      schedulerConfigFromEnv({ ...base, EXECUTION_INSTALLATION_ID: undefined }),
    ).toThrow("EXECUTION_INSTALLATION_ID");
    expect(() =>
      schedulerConfigFromEnv({ ...base, DATABASE_URL: undefined }),
    ).toThrow("DATABASE_URL");
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_IMAGE: undefined }),
    ).toThrow("WORKER_IMAGE");
    expect(() =>
      schedulerConfigFromEnv({ ...base, EXECUTION_SLOT_LIMIT: "-1" }),
    ).toThrow("EXECUTION_SLOT_LIMIT");
    for (const name of [
      "EXECUTION_SLOT_LIMIT",
      "MAX_TURN_SECONDS",
      "QUEUED_INPUT_LIMIT_PER_SESSION",
      "SESSION_COST_LIMIT_USD",
      "STORAGE_LIMIT_BYTES",
    ]) {
      expect(() =>
        schedulerConfigFromEnv({ ...base, [name]: undefined }),
      ).toThrow(`${name} is required`);
    }
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_CPUS: "0.001" }),
    ).toThrow("at least 0.01");
    expect(() => schedulerConfigFromEnv({ ...base, WORKER_CPUS: "0" })).toThrow(
      "WORKER_CPUS",
    );
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_MEMORY_MB: "1.5" }),
    ).toThrow("WORKER_MEMORY_MB");
    expect(() =>
      schedulerConfigFromEnv({ ...base, WORKER_GATEWAY_URL: undefined }),
    ).toThrow("WORKER_GATEWAY_URL");
  });

  test("a zero slot limit is allowed and stops all launches", () => {
    expect(
      schedulerConfigFromEnv({ ...base, EXECUTION_SLOT_LIMIT: "0" }).slotLimit,
    ).toBe(0);
  });
});
