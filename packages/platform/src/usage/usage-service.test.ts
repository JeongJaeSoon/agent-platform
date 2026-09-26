import { describe, expect, test } from "bun:test";
import {
  installationLimitsResponseSchema,
  sessionUsageResponseSchema,
} from "@agent-platform/contracts";
import { allowAllPolicy } from "../authorization/policy.ts";
import type { InstallationLimits } from "../limits/installation-limits.ts";
import type { SessionUsageRecord } from "../ports/usage-reader.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createUsageService, decimalUsd } from "./usage-service.ts";

const limits: InstallationLimits = {
  executionSlotLimit: 0,
  queuedInputLimitPerSession: 3,
  storageLimitBytes: Number.MAX_SAFE_INTEGER,
  maxTurnSeconds: 60,
  sessionCostLimitUsd: 0.0000005,
  providerMaxRetries: 0,
};
const readAt = new Date("2026-09-23T10:00:00.000Z");
const record: SessionUsageRecord = {
  readAt,
  sessionId: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  costUsd: "0.000000",
  reportedTurnCount: 0,
  unreportedTurnCount: 0,
  openTurnCount: 0,
  queuedInputCount: 0,
};

function service(session: SessionUsageRecord | null = record) {
  return createUsageService({
    authorization: allowAllPolicy,
    limits,
    reader: {
      installationUsage: async () => ({
        readAt,
        executionSlotsUsed: 0,
        queuedInputCount: 0,
        storageUsedBytes: 0,
        storageUpdatedAt: null,
      }),
      sessionUsage: async () => session,
    },
  });
}

describe("decimalUsd", () => {
  test("prints a limit exactly, however small, without exponent notation", () => {
    expect(decimalUsd(25)).toBe("25");
    expect(decimalUsd(0.01)).toBe("0.01");
    expect(decimalUsd(1e-7)).toBe("0.0000001");
    expect(decimalUsd(1.5e-7)).toBe("0.00000015");
    expect(decimalUsd(1_000_000)).toBe("1000000");
  });
});

describe("usage service (94S-275)", () => {
  test("a limit finer than the column survives into the contract", async () => {
    const body = await service().getInstallationLimits();
    expect(installationLimitsResponseSchema.parse(body).limits).toMatchObject({
      session_cost_limit_usd: "0.0000005",
      execution_slot_limit: 0,
      provider_max_retries: 0,
    });
    expect(body.usage.storage.updated_at).toBeNull();
  });

  test("an open turn or an unreported one makes the cost incomplete", async () => {
    for (const [counts, complete] of [
      [{}, true],
      [{ openTurnCount: 1 }, false],
      [{ unreportedTurnCount: 1 }, false],
      [{ reportedTurnCount: 4 }, true],
    ] as const) {
      const usage = await service({ ...record, ...counts }).getSessionUsage(
        { ownerId: "owner-a" },
        record.sessionId,
      );
      expect(sessionUsageResponseSchema.parse(usage).cost.complete).toBe(
        complete,
      );
    }
  });

  test("a session the reader does not show the owner is NOT_FOUND", async () => {
    const error = await service(null)
      .getSessionUsage({ ownerId: "owner-a" }, record.sessionId)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).code).toBe("NOT_FOUND");
  });

  test("a zero spend under a sub-micro limit is not over budget, the next micro-dollar is", async () => {
    const zero = await service().getSessionUsage(
      { ownerId: "owner-a" },
      record.sessionId,
    );
    expect(zero.budget_exceeded).toBe(false);
    const spent = await service({
      ...record,
      costUsd: "0.000001",
    }).getSessionUsage({ ownerId: "owner-a" }, record.sessionId);
    expect(spent.budget_exceeded).toBe(true);
  });
});
