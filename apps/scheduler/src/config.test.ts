import { describe, expect, test } from "bun:test";
import { schedulerConfigFromEnv } from "./config.ts";

const base = {
  DATABASE_URL: "postgresql://postgres:dev@127.0.0.1:5432/sessions",
  EXECUTION_INSTALLATION_ID: "dev-a",
  WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
  WORKER_IMAGE: "agent-platform-worker:dev",
};

describe("schedulerConfigFromEnv", () => {
  test("defaults the slot limit to 10 and the worker resources to the documented values", () => {
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
    expect(config.docker.gatewayUrl).toBe(base.WORKER_GATEWAY_URL);
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
