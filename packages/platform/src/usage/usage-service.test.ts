import { describe, expect, test } from "bun:test";
import {
  installationLimitsResponseSchema,
  scopesForRole,
  sessionUsageResponseSchema,
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usageSeriesQuerySchema,
  usageSeriesResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import type { InstallationLimits } from "../limits/installation-limits.ts";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type {
  SessionUsageRecord,
  UsageSummaryFilter,
} from "../ports/usage-reader.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createUsageService, decimalUsd } from "./usage-service.ts";

const limits: InstallationLimits = {
  executionSlotLimit: 0,
  queuedInputLimitPerSession: 3,
  storageLimitBytes: Number.MAX_SAFE_INTEGER,
  maxTurnSeconds: 60,
  sessionCostLimitUsd: 0.0000005,
  sessionTokenLimit: null,
  providerMaxRetries: 0,
};
const readAt = new Date("2026-09-23T10:00:00.000Z");
const record: SessionUsageRecord = {
  readAt,
  sessionId: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  unmetered: false,
  costUsd: "0.000000",
  providerTokens: 0,
  reportedTurnCount: 0,
  unreportedTurnCount: 0,
  openTurnCount: 0,
  queuedInputCount: 0,
};

const WORKSPACE = crypto.randomUUID();
const USER = crypto.randomUUID();
const SERVICE_KEY_ID = crypto.randomUUID();

function user(role: WorkspaceRole): Caller {
  return callerFor(
    {
      kind: "user",
      id: USER,
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );
}

function serviceKey(): Caller {
  return callerFor(
    {
      kind: "api_key",
      id: SERVICE_KEY_ID,
      owner_id: WORKSPACE,
      workspace_id: WORKSPACE,
      scopes: ["sessions:read"],
    },
    { kind: "api" },
    crypto.randomUUID(),
    { creatorId: null },
  );
}

const asked: UsageSummaryFilter[] = [];

function service(
  session: SessionUsageRecord | null = record,
  incompleteTurnCount = 0,
) {
  return createUsageService({
    authorization: createAuthorizationPolicy(),
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
      usageSummary: async (filter, period) => {
        asked.push(filter);
        return {
          readAt,
          until: period.until ?? readAt,
          sessionCount: 3,
          costUsd: "1.250000",
          providerTokens: 42,
          incompleteTurnCount,
          runSeconds: 90,
        };
      },
      usageSeries: async (filter, period) => {
        asked.push(filter);
        return {
          readAt,
          until: period.until ?? readAt,
          buckets: [
            {
              date: "2026-10-01",
              sessionCount: 2,
              costUsd: "1.000000",
              providerTokens: 40,
              incompleteTurnCount,
              runSeconds: 60,
            },
            {
              date: "2026-10-02",
              sessionCount: 0,
              costUsd: "0",
              providerTokens: 0,
              incompleteTurnCount: 0,
              runSeconds: 0,
            },
          ],
        };
      },
      usageBreakdown: async (filter) => {
        asked.push(filter);
        const figures = {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        };
        return {
          rows: [
            {
              key: "agt",
              label: "Bot",
              sessionCount: 2,
              costUsd: "1.000000",
              ...figures,
            },
            {
              key: null,
              label: null,
              sessionCount: 1,
              costUsd: "0.250000",
              ...figures,
            },
          ],
          totals: {
            sessionCount: 3,
            inputTokens: 2,
            outputTokens: 4,
            cacheReadInputTokens: 6,
            cacheCreationInputTokens: 8,
            costUsd: "1.250000",
          },
        };
      },
    },
  });
}

const query = (scope: "installation" | "me") =>
  usageSummaryQuerySchema.parse({ scope, since: "2026-10-01" });

describe("decimalUsd", () => {
  test("prints a limit exactly, however small, without exponent notation", () => {
    expect(decimalUsd(25)).toBe("25");
    expect(decimalUsd(0.01)).toBe("0.01");
    expect(decimalUsd(1e-7)).toBe("0.0000001");
    expect(decimalUsd(1.5e-7)).toBe("0.00000015");
    expect(decimalUsd(1_000_000)).toBe("1000000");
  });
});

describe("usage service", () => {
  test("a limit finer than the column survives into the contract", async () => {
    const body = await service().getInstallationLimits(user("owner"));
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
        testCaller("owner-a"),
        record.sessionId,
      );
      expect(sessionUsageResponseSchema.parse(usage).cost.complete).toBe(
        complete,
      );
    }
  });

  test("a session the reader does not show the owner is NOT_FOUND", async () => {
    const error = await service(null)
      .getSessionUsage(testCaller("owner-a"), record.sessionId)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).code).toBe("NOT_FOUND");
  });

  test("a zero spend under a sub-micro limit is not over budget, the next micro-dollar is", async () => {
    const zero = await service().getSessionUsage(
      testCaller("owner-a"),
      record.sessionId,
    );
    expect(zero.budget_exceeded).toBe(false);
    const spent = await service({
      ...record,
      costUsd: "0.000001",
    }).getSessionUsage(testCaller("owner-a"), record.sessionId);
    expect(spent.budget_exceeded).toBe(true);
  });

  test("a session accepted on a billing none profile reads unmetered", async () => {
    for (const [unmetered, kind, costLimit] of [
      [true, "unmetered", null],
      [false, "estimated", "0.0000005"],
    ] as const) {
      const usage = await service({ ...record, unmetered }).getSessionUsage(
        testCaller("owner-a"),
        record.sessionId,
      );
      const parsed = sessionUsageResponseSchema.parse(usage);
      expect(parsed.cost.kind).toBe(kind);
      expect(parsed.cost_limit_usd).toBe(costLimit);
      expect(usage.budget_exceeded).toBe(false);
    }
  });

  test("installation figures are refused to anyone but the owner, before anything is read", async () => {
    for (const caller of [
      user("admin"),
      user("member"),
      serviceKey(),
      testCaller(WORKSPACE),
    ]) {
      asked.length = 0;
      for (const read of [
        () => service().getInstallationLimits(caller),
        () => service().getUsageSummary(caller, query("installation")),
      ]) {
        const error = await read().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SessionServiceError);
        expect((error as SessionServiceError).code).toBe("FORBIDDEN");
      }
      expect(asked).toEqual([]);
    }
    asked.length = 0;
    await service().getUsageSummary(user("owner"), query("installation"));
    expect(asked).toEqual([{ kind: "installation" }]);
  });

  test("scope=me sums what the caller started: a person's, else the key's", async () => {
    asked.length = 0;
    await service().getUsageSummary(user("member"), query("me"));
    await service().getUsageSummary(serviceKey(), query("me"));
    expect(asked).toEqual([
      { kind: "user", ownerId: WORKSPACE, userId: USER },
      { kind: "api_key", ownerId: WORKSPACE, apiKeyId: SERVICE_KEY_ID },
    ]);
    const error = await service()
      .getUsageSummary(testCaller(WORKSPACE), query("me"))
      .catch((caught: unknown) => caught);
    expect((error as SessionServiceError).code).toBe("FORBIDDEN");
  });

  // The rule GET /v1/sessions applies: a key bound to an agent reaches that
  // agent's sessions one by one, never a read across them.
  test("a key bound to an agent is refused scope=me, as it is the session list", async () => {
    const bound = createUsageService({
      authorization: createAuthorizationPolicy({
        identity: {
          reread: async (subject) => ({
            status: "ok",
            principal: subject.principal,
            keyAgentId: crypto.randomUUID(),
          }),
        },
      }),
      limits,
      reader: {
        installationUsage: async () => {
          throw new Error("not read");
        },
        sessionUsage: async () => null,
        usageSummary: async () => {
          throw new Error("not read");
        },
        usageSeries: async () => {
          throw new Error("not read");
        },
        usageBreakdown: async () => {
          throw new Error("not read");
        },
      },
    });
    const error = await bound
      .getUsageSummary(serviceKey(), query("me"))
      .catch((caught: unknown) => caught);
    expect((error as SessionServiceError).code).toBe("FORBIDDEN");
  });

  test("the summary echoes the period on UTC and is incomplete while any turn is", async () => {
    const complete = usageSummaryResponseSchema.parse(
      await service().getUsageSummary(user("member"), query("me")),
    );
    expect(complete).toEqual({
      scope: "me",
      period: {
        since: "2026-10-01T00:00:00.000Z",
        until: readAt.toISOString(),
      },
      refreshed_at: readAt.toISOString(),
      session_count: 3,
      cost_usd: "1.250000",
      cost_complete: true,
      token_count: 42,
      run_seconds: 90,
      basis: {
        sessions: "created_in_period",
        cost: "provider_usage_estimate",
        run_time: "turn_wall_clock",
      },
    });
    const open = await service(record, 1).getUsageSummary(
      user("member"),
      query("me"),
    );
    expect(open.cost_complete).toBe(false);
  });

  test("a breakdown is gated like the summary and counts the four token columns", async () => {
    const breakdownQuery = (scope: "installation" | "me") =>
      usageBreakdownQuerySchema.parse({
        scope,
        since: "2026-10-01",
        by: "agent",
      });
    for (const role of ["admin", "member"] as const) {
      const error = await service()
        .getUsageBreakdown(user(role), breakdownQuery("installation"))
        .catch((caught: unknown) => caught);
      expect((error as SessionServiceError).code, role).toBe("FORBIDDEN");
    }
    const response = usageBreakdownResponseSchema.parse(
      await service().getUsageBreakdown(
        user("owner"),
        breakdownQuery("installation"),
      ),
    );
    expect(response.rows[1]).toEqual({
      key: null,
      label: null,
      session_count: 1,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
      token_count: 10,
      cost_usd: "0.250000",
    });
    expect(response.totals).toMatchObject({
      token_count: 20,
      cost_usd: "1.250000",
    });
  });

  test("breakdown token counts stop at the largest safe integer as provider_tokens does", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    // One session at the cap plus one more call, and two sessions at it.
    const figures = {
      sessionCount: 2,
      inputTokens: max,
      outputTokens: 1,
      cacheReadInputTokens: Number("18014398509481982"),
      cacheCreationInputTokens: 0,
      costUsd: "0.000000",
    };
    const bound = createUsageService({
      authorization: createAuthorizationPolicy(),
      limits,
      reader: {
        installationUsage: async () => {
          throw new Error("not read");
        },
        sessionUsage: async () => null,
        usageSummary: async () => {
          throw new Error("not read");
        },
        usageSeries: async () => {
          throw new Error("not read");
        },
        usageBreakdown: async () => ({
          rows: [
            { key: "claude-opus-5-5", label: "claude-opus-5-5", ...figures },
          ],
          totals: figures,
        }),
      },
    });
    const response = usageBreakdownResponseSchema.parse(
      await bound.getUsageBreakdown(
        user("owner"),
        usageBreakdownQuerySchema.parse({
          scope: "installation",
          since: "2026-10-01",
          by: "model",
        }),
      ),
    );
    for (const figuresOut of [response.totals, response.rows[0]]) {
      expect(figuresOut).toMatchObject({
        input_tokens: max,
        output_tokens: 1,
        cache_read_input_tokens: max,
        token_count: max,
      });
    }
  });

  test("a series is gated like the summary and marks only its incomplete days", async () => {
    const seriesQuery = (scope: "installation" | "me") =>
      usageSeriesQuerySchema.parse({ scope, since: "2026-10-01" });
    for (const role of ["admin", "member"] as const) {
      const error = await service()
        .getUsageSeries(user(role), seriesQuery("installation"))
        .catch((caught: unknown) => caught);
      expect((error as SessionServiceError).code, role).toBe("FORBIDDEN");
    }
    const response = usageSeriesResponseSchema.parse(
      await service(record, 1).getUsageSeries(user("owner"), seriesQuery("me")),
    );
    expect(response).toEqual({
      period: {
        since: "2026-10-01T00:00:00.000Z",
        until: readAt.toISOString(),
      },
      refreshed_at: readAt.toISOString(),
      buckets: [
        {
          date: "2026-10-01",
          session_count: 2,
          cost_usd: "1.000000",
          cost_complete: false,
          token_count: 40,
          run_seconds: 60,
        },
        {
          date: "2026-10-02",
          session_count: 0,
          cost_usd: "0",
          cost_complete: true,
          token_count: 0,
          run_seconds: 0,
        },
      ],
    });
  });
});
