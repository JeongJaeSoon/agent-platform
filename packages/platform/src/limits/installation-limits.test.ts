import { describe, expect, test } from "bun:test";
import {
  budgetExceeded,
  InstallationConfigError,
  installationLimitProblems,
  installationLimitsFromEnv,
} from "./installation-limits.ts";

const complete = {
  EXECUTION_SLOT_LIMIT: "10",
  MAX_TURN_SECONDS: "3600",
  PROVIDER_MAX_RETRIES: "2",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
};

describe("installationLimitsFromEnv", () => {
  test("reads every limit", () => {
    expect(installationLimitsFromEnv(complete)).toEqual({
      executionSlotLimit: 10,
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
      queuedInputLimitPerSession: 20,
      sessionCostLimitUsd: 25,
      storageLimitBytes: 1073741824,
    });
    expect(
      installationLimitsFromEnv({ ...complete, PROVIDER_MAX_RETRIES: "0" })
        .providerMaxRetries,
    ).toBe(0);
  });

  test("names every missing limit at once and has no defaults for them", () => {
    let thrown: unknown;
    try {
      installationLimitsFromEnv({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstallationConfigError);
    expect((thrown as InstallationConfigError).problems).toEqual([
      "EXECUTION_SLOT_LIMIT is required",
      "QUEUED_INPUT_LIMIT_PER_SESSION is required",
      "STORAGE_LIMIT_BYTES is required",
      "MAX_TURN_SECONDS is required",
      "SESSION_COST_LIMIT_USD is required",
      "PROVIDER_MAX_RETRIES is required",
    ]);
  });

  test("rejects values outside each limit's range", () => {
    const rejected: Record<string, string[]> = {
      EXECUTION_SLOT_LIMIT: ["-1", "1.5", "10001", "ten"],
      QUEUED_INPUT_LIMIT_PER_SESSION: ["0", "100001"],
      STORAGE_LIMIT_BYTES: ["0", "9007199254740993"],
      MAX_TURN_SECONDS: ["0", "604801"],
      SESSION_COST_LIMIT_USD: ["0", "-5", "Infinity", "abc", "1000001"],
      PROVIDER_MAX_RETRIES: ["-1", "1.5", "11", ""],
    };
    for (const [name, values] of Object.entries(rejected)) {
      for (const value of values) {
        const problems = installationLimitProblems({
          ...complete,
          [name]: value,
        });
        expect(problems, `${name}=${value}`).toHaveLength(1);
        expect(problems[0], `${name}=${value}`).toStartWith(name);
      }
    }
  });

  test("accepts a zero slot limit and a fractional cost limit", () => {
    expect(
      installationLimitsFromEnv({
        ...complete,
        EXECUTION_SLOT_LIMIT: "0",
        SESSION_COST_LIMIT_USD: "0.5",
      }),
    ).toMatchObject({ executionSlotLimit: 0, sessionCostLimitUsd: 0.5 });
  });
});

test("the budget is spent once the cost reaches the limit", () => {
  expect(budgetExceeded(24.999999, 25)).toBe(false);
  expect(budgetExceeded(25, 25)).toBe(true);
  expect(budgetExceeded(30, 25)).toBe(true);
});
