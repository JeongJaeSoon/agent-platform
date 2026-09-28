import { describe, expect, test } from "bun:test";
import {
  ApiSettingsError,
  apiSettingsFromEnv,
  apiSettingsProblems,
  heartbeatTtlMsFromEnv,
} from "./api-settings.ts";

describe("apiSettingsFromEnv", () => {
  test("unset keeps every default", () => {
    expect(apiSettingsFromEnv({})).toEqual({
      leaseTtlMs: 30_000,
      logLevel: "info",
      pendingTtlMs: 1_800_000,
      sse: {},
    });
  });

  test("reads what is set", () => {
    expect(
      apiSettingsFromEnv({
        HEARTBEAT_TTL_SEC: "45",
        LOG_LEVEL: "debug",
        PENDING_REQUEST_TTL_SEC: "3600",
        SSE_MAX_STREAMS: "512",
        SSE_MAX_STREAMS_PER_OWNER: "16",
        SSE_REPLAY_MAX_BYTES: "65536",
      }),
    ).toEqual({
      leaseTtlMs: 45_000,
      logLevel: "debug",
      pendingTtlMs: 3_600_000,
      sse: { batchMaxBytes: 65_536, maxStreams: 512, maxStreamsPerOwner: 16 },
    });
  });

  // The ticket's reproduction: each of these used to start the API on a
  // default nobody chose.
  test.each([
    ["PENDING_REQUEST_TTL_SEC", "0"],
    ["PENDING_REQUEST_TTL_SEC", "-1"],
    ["PENDING_REQUEST_TTL_SEC", "0.001"],
    ["PENDING_REQUEST_TTL_SEC", "1e12"],
    ["PENDING_REQUEST_TTL_SEC", "30m"],
    ["PENDING_REQUEST_TTL_SEC", ""],
    ["SSE_MAX_STREAMS", "25O"],
    ["SSE_MAX_STREAMS", "0"],
    ["SSE_MAX_STREAMS_PER_OWNER", "-8"],
    ["SSE_REPLAY_MAX_BYTES", "1.5"],
    ["LOG_LEVEL", "inf0"],
    ["HEARTBEAT_TTL_SEC", "10"],
  ])("%s=%p stops the API", (name, value) => {
    expect(() => apiSettingsFromEnv({ [name]: value })).toThrow(name);
  });

  test("AUTH_MODE=none is refused where workers can reach the API", () => {
    expect(() =>
      apiSettingsFromEnv({ AUTH_MODE: "none", EGRESS_AUTHORIZER_PORT: "3100" }),
    ).toThrow("AUTH_MODE=none cannot run with the egress authorizer on");
    // Without the authorizer no worker reaches a provider, so none do run.
    expect(apiSettingsFromEnv({ AUTH_MODE: "none" }).leaseTtlMs).toBe(30_000);
    expect(
      apiSettingsFromEnv({
        AUTH_MODE: "api-key",
        EGRESS_AUTHORIZER_PORT: "3100",
      }).leaseTtlMs,
    ).toBe(30_000);
  });

  test("names every problem at once", () => {
    const environment = {
      SSE_MAX_STREAMS: "25O",
      PENDING_REQUEST_TTL_SEC: "0",
      LOG_LEVEL: "loud",
    };
    let thrown: unknown;
    try {
      apiSettingsFromEnv(environment);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiSettingsError);
    expect(apiSettingsProblems(environment)).toEqual([
      'LOG_LEVEL must be one of debug|info|warn|error, got "loud"',
      "PENDING_REQUEST_TTL_SEC must be an integer from 1 to 604800",
      "SSE_MAX_STREAMS must be a positive integer",
    ]);
    expect(apiSettingsProblems({})).toEqual([]);
  });
});

describe("heartbeatTtlMsFromEnv", () => {
  test("unset is the platform default; a positive number is seconds", () => {
    expect(heartbeatTtlMsFromEnv(undefined)).toBe(30_000);
    expect(heartbeatTtlMsFromEnv("45")).toBe(45_000);
    expect(heartbeatTtlMsFromEnv("20.5")).toBe(20_500);
  });

  test("anything else stops the API instead of becoming the default", () => {
    expect(heartbeatTtlMsFromEnv("86400")).toBe(86_400_000);
    for (const value of [
      "",
      " ",
      "0",
      "-5",
      // At or under the worker's margin + interval (10 s + 10 s): every
      // attempt would give its lease up at or near its first beat.
      "0.5",
      "10",
      "20",
      "abc",
      "Infinity",
      "NaN",
      "86401",
      "1e308",
    ]) {
      expect(() => heartbeatTtlMsFromEnv(value)).toThrow(
        /^HEARTBEAT_TTL_SEC must be a number of seconds above 20 /,
      );
    }
  });
});
