import { describe, expect, test } from "bun:test";
import {
  installationLimitsResponseSchema,
  scopesForRole,
  sessionUsageResponseSchema,
  type UsageToolsResponse,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  usageToolsQuerySchema,
  usageToolsResponseSchema,
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
import {
  createUsageService,
  decimalUsd,
  toolFindings,
} from "./usage-service.ts";

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
      usageTools: async (filter) => {
        asked.push(filter);
        return [];
      },
    },
  });
}

const query = (scope: "installation" | "me") =>
  usageSummaryQuerySchema.parse({ scope, since: "2026-10-01" });
const toolsQuery = (scope: "installation" | "me") =>
  usageToolsQuerySchema.parse({ scope, since: "2026-10-01" });

const tool = (
  name: string,
  figures: Partial<UsageToolsResponse["tools"][number]> = {},
) => ({
  name,
  calls: 10,
  failed: 0,
  total_ms: 0,
  median_ms: 0,
  max_ms: 0,
  ...figures,
});

describe("toolFindings", () => {
  test("names the most time in all, the highest failure rate and the slowest median", () => {
    // The operations design's figures: Bash fails more times, Edit at the
    // higher rate.
    const tools = [
      tool("Bash", {
        calls: 1840,
        failed: 21,
        total_ms: 13_320_000,
        median_ms: 3100,
      }),
      tool("Edit", { calls: 702, failed: 12, total_ms: 1_620_000 }),
      tool("WebFetch", { calls: 214, total_ms: 3_960_000, median_ms: 12_400 }),
    ];
    expect(toolFindings(tools)).toEqual([
      { kind: "most_time", name: "Bash" },
      { kind: "fails_often", name: "Edit" },
      { kind: "slowest", name: "WebFetch" },
    ]);
  });

  test("leaves out a kind no tool qualifies for and breaks ties on the name", () => {
    expect(toolFindings([])).toEqual([]);
    expect(toolFindings([tool("Read"), tool("Bash")])).toEqual([]);
    expect(
      toolFindings([
        tool("Read", { failed: 1, median_ms: 5, total_ms: 50 }),
        tool("Grep", { failed: 1, median_ms: 5, total_ms: 50 }),
      ]),
    ).toEqual([
      { kind: "most_time", name: "Grep" },
      { kind: "fails_often", name: "Grep" },
      { kind: "slowest", name: "Grep" },
    ]);
  });
});

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
        () => service().getUsageTools(caller, toolsQuery("installation")),
      ]) {
        const error = await read().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SessionServiceError);
        expect((error as SessionServiceError).code).toBe("FORBIDDEN");
      }
      expect(asked).toEqual([]);
    }
    asked.length = 0;
    await service().getUsageSummary(user("owner"), query("installation"));
    await service().getUsageTools(user("owner"), toolsQuery("installation"));
    expect(asked).toEqual([{ kind: "installation" }, { kind: "installation" }]);
  });

  test("tools for scope=me count what the caller started, as the summary does", async () => {
    asked.length = 0;
    const body = await service().getUsageTools(
      user("member"),
      toolsQuery("me"),
    );
    expect(usageToolsResponseSchema.parse(body)).toEqual({
      tools: [],
      findings: [],
    });
    expect(asked).toEqual([{ kind: "user", ownerId: WORKSPACE, userId: USER }]);
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
        usageTools: async () => {
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
});
