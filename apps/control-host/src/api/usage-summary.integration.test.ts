import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  memberLimitsResponseSchema,
  type Principal,
  scopesForRole,
  type UsageSummaryResponse,
  usageOutcomesQuerySchema,
  usageOutcomesResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  usageToolsResponseSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  authzDecisions,
  createApiKey,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  createPostgresSessionUnitOfWork,
  createPostgresUsageReader,
  memberships,
  sessions,
  turns,
  users,
  workspaces,
} from "@werft-ai/db";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  createUsageService,
  type InputLimits,
  SessionServiceError,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerUsageRoutes } from "./routes/usage.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const roomy: InputLimits = {
  queuedInputLimitPerSession: 1_000,
  storageLimitBytes: Number.MAX_SAFE_INTEGER,
};

integration("usage summary on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let service: ReturnType<typeof createUsageService>;
  const workspaceId = crypto.randomUUID();
  const ids = {
    owner: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    alice: crypto.randomUUID(),
    bob: crypto.randomUUID(),
  };
  const personalKey = crypto.randomUUID();
  const ownersKey = crypto.randomUUID();
  const agentKey = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const agentReleaseId = `rel-${crypto.randomUUID()}`;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "usage_summary_it" });
    pool = new Pool({ connectionString: database.url, max: 5 });
    db = drizzle(pool, { schema });
    service = createUsageService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
        decisions: createPostgresDecisionLog(db),
      }),
      reader: createPostgresUsageReader(db),
      limits: {
        executionSlotLimit: 10,
        queuedInputLimitPerSession: 20,
        storageLimitBytes: 1_073_741_824,
        maxTurnSeconds: 3600,
        sessionCostLimitUsd: 2.5,
        sessionTokenLimit: null,
        providerMaxRetries: 2,
      },
    });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    for (const [who, id] of Object.entries(ids)) {
      await db.insert(users).values({
        id,
        email: `${who}@example.com`,
        displayName: who,
      });
      await db.insert(memberships).values({
        workspaceId,
        userId: id,
        role: who === "owner" ? "owner" : who === "admin" ? "admin" : "member",
      });
    }
    await db
      .insert(schema.agents)
      .values({ id: agentId, workspaceId, slug: "bot", name: "Bot" });
    const versionId = crypto.randomUUID();
    await db.insert(schema.agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {},
      contentSha256: "a".repeat(64),
    });
    await db.insert(schema.agentReleases).values({
      id: agentReleaseId,
      agentId,
      versionId,
      cardSha256: "a".repeat(64),
      runtimeProfileId: "claude-coding-v1",
      profileDigest: "digest",
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    for (const [id, creator] of [
      [personalKey, ids.alice],
      [ownersKey, ids.owner],
      [agentKey, null],
    ] as const) {
      await createApiKey(db, {
        id,
        ownerId: workspaceId,
        keyHash: crypto.getRandomValues(new Uint8Array(32)),
        scopes: ["sessions:read", "sessions:write"],
        workspaceId,
        kind: creator === null ? "agent" : "personal",
        agentId: creator === null ? agentId : null,
        createdByUserId: creator,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function user(who: keyof typeof ids, role: WorkspaceRole): Caller {
    return callerFor(
      {
        kind: "user",
        id: ids[who],
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
  }

  function key(id: string, creator: string | null): Caller {
    const principal: Principal = {
      kind: "api_key",
      id,
      owner_id: workspaceId,
      workspace_id: workspaceId,
      scopes: ["sessions:read", "sessions:write"],
    };
    return callerFor(principal, { kind: "api" }, crypto.randomUUID(), {
      creatorId: creator,
    });
  }

  // A session made by `caller` at `createdAt`, holding `costUsd` and
  // `tokens`, its one turn ended with a reported cost.
  async function session(
    caller: Caller,
    createdAt: string,
    costUsd: number,
    tokens: number,
    release?: string,
  ) {
    const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic(
      {
        limits: roomy,
        principal: caller,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        profileId: "claude-coding-v1",
        repository: "none",
        message: "count me",
        ...(release ? { agentReleaseId: release } : {}),
      },
    );
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const id = created.response.session_id;
    await db
      .update(sessions)
      .set({ createdAt: new Date(createdAt), costUsd, providerTokens: tokens })
      .where(eq(sessions.id, id));
    await setTurn(id, {
      status: "completed",
      startedAt: new Date(createdAt),
      endedAt: new Date(new Date(createdAt).getTime() + 60_000),
      attemptId: "attempt-1",
      resultJson: { cost_usd: costUsd },
    });
    return id;
  }

  function setTurn(
    sessionId: string,
    values: Partial<typeof turns.$inferInsert>,
  ) {
    return db
      .update(turns)
      .set(values)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
  }

  async function summary(
    caller: Caller,
    query: Record<string, string>,
  ): Promise<UsageSummaryResponse> {
    return usageSummaryResponseSchema.parse(
      await service.getUsageSummary(
        caller,
        usageSummaryQuerySchema.parse(query),
      ),
    );
  }

  async function refusal(promise: Promise<unknown>) {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    return (error as SessionServiceError).code;
  }

  test("scope=me adds up only the sessions the caller started, its personal keys' included", async () => {
    const period = { since: "2001-03-01", until: "2001-04-01" };
    await session(user("alice", "member"), "2001-03-02T00:00:00Z", 0.25, 100);
    await session(
      key(personalKey, ids.alice),
      "2001-03-03T00:00:00Z",
      0.5,
      200,
    );
    await session(user("bob", "member"), "2001-03-04T00:00:00Z", 4, 4_000);
    await session(
      key(agentKey, null),
      "2001-03-05T00:00:00Z",
      8,
      8_000,
      agentReleaseId,
    );
    await session(testCaller("legacy-owner"), "2001-03-06T00:00:00Z", 16, 1);

    const alice = await summary(user("alice", "member"), {
      scope: "me",
      ...period,
    });
    expect(alice).toMatchObject({
      scope: "me",
      session_count: 2,
      cost_usd: "0.750000",
      cost_complete: true,
      token_count: 300,
      run_seconds: 120,
    });
    // Her personal key counts as her, the console's sessions included.
    expect(
      await summary(key(personalKey, ids.alice), { scope: "me", ...period }),
    ).toMatchObject({ session_count: 2, cost_usd: "0.750000" });
    expect(
      await summary(user("bob", "member"), { scope: "me", ...period }),
    ).toMatchObject({ session_count: 1, cost_usd: "4.000000" });
    // A summary names no agent, so an agent key reads none (agent_ceiling).
    expect(
      await refusal(summary(key(agentKey, null), { scope: "me", ...period })),
    ).toBe("FORBIDDEN");
    // An owner reading their own figure sees none of the others'.
    expect(
      await summary(user("owner", "owner"), { scope: "me", ...period }),
    ).toMatchObject({ session_count: 0, cost_usd: "0", token_count: 0 });
    // AUTH_MODE=none names no one who started anything.
    expect(
      await refusal(
        service.getUsageSummary(
          testCaller(workspaceId),
          usageSummaryQuerySchema.parse({ scope: "me", ...period }),
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  test("scope=installation and GET /v1/limits are the signed-in owner's alone", async () => {
    const period = { since: "2002-01-01", until: "2003-01-01" };
    await session(user("alice", "member"), "2002-05-01T00:00:00Z", 1, 10);
    await session(testCaller("legacy-owner"), "2002-06-01T00:00:00Z", 2, 20);

    expect(
      await summary(user("owner", "owner"), {
        scope: "installation",
        ...period,
      }),
    ).toMatchObject({
      scope: "installation",
      session_count: 2,
      cost_usd: "3.000000",
      token_count: 30,
    });
    expect(
      (await service.getInstallationLimits(user("owner", "owner"))).scope,
    ).toBe("installation");

    const query = usageSummaryQuerySchema.parse({
      scope: "installation",
      ...period,
    });
    for (const [label, caller] of [
      ["admin", user("admin", "admin")],
      ["member", user("alice", "member")],
      ["owner's personal key", key(ownersKey, ids.owner)],
      ["agent key", key(agentKey, null)],
      ["legacy key", testCaller("legacy-owner")],
      // The role is read again: a token minted as owner does not outlive it.
      ["member claiming owner", user("alice", "owner")],
    ] as const) {
      expect(await refusal(service.getUsageSummary(caller, query)), label).toBe(
        "FORBIDDEN",
      );
      expect(await refusal(service.getInstallationLimits(caller)), label).toBe(
        "FORBIDDEN",
      );
    }
  });

  test("scope=agent adds up the sessions of any of the agent's releases, for its managers alone", async () => {
    const period = { since: "2004-01-01", until: "2005-01-01" };
    // A second release of the agent, and another agent beside it.
    async function release(agent: string) {
      const versionId = crypto.randomUUID();
      await db.insert(schema.agentVersions).values({
        id: versionId,
        agentId: agent,
        versionNo: 1 + Math.floor(Math.random() * 1e6),
        card: {},
        contentSha256: "b".repeat(64),
      });
      const id = `rel-${crypto.randomUUID()}`;
      await db.insert(schema.agentReleases).values({
        id,
        agentId: agent,
        versionId,
        cardSha256: "b".repeat(64),
        runtimeProfileId: "claude-coding-v1",
        profileDigest: "digest",
        runtimeConfigSnapshot: {},
        effectiveTools: [],
      });
      return id;
    }
    const secondRelease = await release(agentId);
    const otherAgent = crypto.randomUUID();
    await db
      .insert(schema.agents)
      .values({ id: otherAgent, workspaceId, slug: "other", name: "Other" });
    const otherRelease = await release(otherAgent);
    const elsewhere = crypto.randomUUID();
    const foreignAgent = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: elsewhere, slug: "elsewhere", name: "Elsewhere" });
    await db.insert(schema.agents).values({
      id: foreignAgent,
      workspaceId: elsewhere,
      slug: "bot",
      name: "Bot",
    });
    await db
      .insert(schema.agentAdmins)
      .values({ workspaceId, agentId, userId: ids.bob });

    await session(
      key(agentKey, null),
      "2004-02-01T00:00:00Z",
      1,
      10,
      agentReleaseId,
    );
    await session(
      user("alice", "member"),
      "2004-03-01T00:00:00Z",
      2,
      20,
      secondRelease,
    );
    await session(
      user("alice", "member"),
      "2004-04-01T00:00:00Z",
      4,
      40,
      otherRelease,
    );
    await session(user("alice", "member"), "2004-05-01T00:00:00Z", 8, 80);
    // Outside the period.
    await session(
      user("alice", "member"),
      "2005-01-01T00:00:00Z",
      16,
      160,
      agentReleaseId,
    );

    const query = { scope: "agent", agent_id: agentId, ...period };
    for (const [label, caller] of [
      ["owner", user("owner", "owner")],
      ["admin", user("admin", "admin")],
      ["the agent's admin", user("bob", "member")],
    ] as const) {
      const body = await summary(caller, query);
      expect(body, label).toMatchObject({
        scope: "agent",
        session_count: 2,
        cost_usd: "3.000000",
        token_count: 30,
        cost_complete: true,
        run_seconds: 120,
      });
      expect(body, label).not.toHaveProperty("groups");
    }

    const requestId = crypto.randomUUID();
    const admin = callerFor(
      {
        kind: "user",
        id: ids.admin,
        workspace_id: workspaceId,
        role: "admin",
        scopes: [...scopesForRole("admin")],
      },
      { kind: "web" },
      requestId,
    );
    await summary(admin, query);
    const decided = await db
      .select()
      .from(authzDecisions)
      .where(eq(authzDecisions.requestId, requestId));
    expect(
      decided.map(({ action, resourceKind, resourceId, outcome }) => ({
        action,
        resourceKind,
        resourceId,
        outcome,
      })),
    ).toEqual([
      {
        action: "usage.agent_read",
        resourceKind: "agent",
        resourceId: agentId,
        outcome: "allow",
      },
    ]);

    for (const [label, caller] of [
      ["member", user("alice", "member")],
      ["another agent's admin", user("bob", "member")],
      ["agent key", key(agentKey, null)],
      ["personal key", key(personalKey, ids.alice)],
    ] as const) {
      const agent = label === "another agent's admin" ? otherAgent : agentId;
      expect(
        await refusal(summary(caller, { ...query, agent_id: agent })),
        label,
      ).toBe("FORBIDDEN");
    }
    for (const agent of [foreignAgent, crypto.randomUUID()]) {
      expect(
        await refusal(
          summary(user("owner", "owner"), { ...query, agent_id: agent }),
        ),
      ).toBe("NOT_FOUND");
    }
  });

  test("GET /v1/usage/outcomes counts each session's cost once, those without a pull request included, and its total is the summary's", async () => {
    const period = { since: "2007-01-01", until: "2007-02-01" };
    const agent = key(agentKey, null);
    const two = await session(
      agent,
      "2007-01-02T00:00:00Z",
      1,
      10,
      agentReleaseId,
    );
    const one = await session(
      user("alice", "member"),
      "2007-01-03T00:00:00Z",
      2,
      20,
      agentReleaseId,
    );
    await session(agent, "2007-01-04T00:00:00Z", 4, 40, agentReleaseId);
    // Not the agent's.
    const other = await session(
      user("alice", "member"),
      "2007-01-05T00:00:00Z",
      8,
      80,
    );
    let number = 0;
    const outcome = (
      sessionId: string,
      state: "open" | "merged" | "closed",
    ) => {
      number += 1;
      return db.insert(schema.sessionOutcomes).values({
        id: crypto.randomUUID(),
        ownerId: workspaceId,
        sessionId,
        type: "github_pull_request",
        url: `https://github.com/acme/app/pull/${number}`,
        repositoryId: "app",
        externalId: String(number),
        state,
        stateChangedAt: new Date(),
      });
    };
    await outcome(two, "merged");
    await outcome(two, "open");
    await outcome(one, "closed");
    await outcome(other, "merged");

    const query = { scope: "agent", agent_id: agentId, ...period };
    const body = usageOutcomesResponseSchema.parse(
      await service.getUsageOutcomes(
        user("owner", "owner"),
        usageOutcomesQuerySchema.parse(query),
      ),
    );
    expect(body).toMatchObject({
      scope: "agent",
      session_count: 3,
      cost_usd: "7.000000",
      cost_complete: true,
      token_count: 70,
      sessions_with_pr: 2,
      sessions_with_merged_pr: 1,
      pr_count: 3,
      merged_pr_count: 1,
      closed_pr_count: 1,
      cost_of_merged_sessions_usd: "1.000000",
      cost_per_merged_pr_usd: "7.000000",
    });
    expect(body).not.toHaveProperty("groups");
    const same = await summary(user("owner", "owner"), query);
    expect([body.session_count, body.cost_usd]).toEqual([
      same.session_count,
      same.cost_usd,
    ]);

    const installation = { scope: "installation", ...period };
    const grouped = usageOutcomesResponseSchema.parse(
      await service.getUsageOutcomes(
        user("owner", "owner"),
        usageOutcomesQuerySchema.parse({ ...installation, group_by: "agent" }),
      ),
    );
    const whole = await summary(user("owner", "owner"), installation);
    expect([grouped.session_count, grouped.cost_usd]).toEqual([
      whole.session_count,
      whole.cost_usd,
    ]);
    expect(grouped).toMatchObject({
      session_count: 4,
      pr_count: 4,
      merged_pr_count: 2,
      cost_per_merged_pr_usd: "7.500000",
    });
    expect(grouped.groups).toEqual([
      expect.objectContaining({
        id: null,
        name: null,
        session_count: 1,
        cost_usd: "8.000000",
        merged_pr_count: 1,
      }),
      expect.objectContaining({
        id: agentId,
        name: "Bot",
        session_count: 3,
        cost_usd: "7.000000",
        pr_count: 3,
      }),
    ]);

    // Who reads which scope is the summary's: a member is refused the
    // agent's figure, and an agent key reads none.
    const outcomes = (caller: Caller, read: Record<string, string>) =>
      service.getUsageOutcomes(caller, usageOutcomesQuerySchema.parse(read));
    expect(await refusal(outcomes(user("alice", "member"), query))).toBe(
      "FORBIDDEN",
    );
    expect(
      await refusal(
        outcomes(user("alice", "member"), {
          scope: "installation",
          ...period,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await refusal(outcomes(agent, { scope: "me", ...period }))).toBe(
      "FORBIDDEN",
    );
    expect(await refusal(outcomes(agent, query))).toBe("FORBIDDEN");
  });

  test("cost_usd is the sum of the sessions' usage and is incomplete while one of them is", async () => {
    const period = { since: "2004-01-01", until: "2004-02-01" };
    const caller = user("bob", "member");
    const first = await session(caller, "2004-01-02T00:00:00Z", 0.123456, 5);
    const second = await session(caller, "2004-01-03T00:00:00Z", 1.5, 7);
    const sessionTotal = async () => {
      let micros = 0;
      for (const id of [first, second]) {
        const usage = await service.getSessionUsage(caller, id);
        micros += Math.round(Number(usage.cost.amount_usd) * 1e6);
      }
      return micros;
    };

    const complete = await summary(caller, { scope: "me", ...period });
    expect(Math.round(Number(complete.cost_usd) * 1e6)).toBe(
      await sessionTotal(),
    );
    expect(complete.cost_complete).toBe(true);

    for (const values of [
      // Still running.
      { status: "running", endedAt: null, resultJson: null },
      // Ended without a figure.
      { status: "failed", resultJson: null },
    ] as const) {
      await setTurn(second, values);
      const read = await summary(caller, { scope: "me", ...period });
      expect(read.cost_complete).toBe(false);
      expect(
        (await service.getSessionUsage(caller, second)).cost.complete,
      ).toBe(false);
    }
  });

  test("group_by splits the same summary by agent or user, and the groups add up to it", async () => {
    const period = { since: "2006-01-01", until: "2006-02-01" };
    const alice = user("alice", "member");
    const bob = user("bob", "member");
    const halfSecond = async (id: string, start: string) =>
      setTurn(id, {
        startedAt: new Date(start),
        endedAt: new Date(new Date(start).getTime() + 1_500),
      });
    const a1 = await session(alice, "2006-01-02T00:00:00Z", 0.1, 1);
    await halfSecond(a1, "2006-01-02T00:00:00Z");
    const a2 = await session(
      alice,
      "2006-01-03T00:00:00Z",
      0.25,
      2,
      agentReleaseId,
    );
    await halfSecond(a2, "2006-01-03T00:00:00Z");
    const b1 = await session(bob, "2006-01-04T00:00:00Z", 0.3, 3);
    await setTurn(b1, { status: "failed", resultJson: null });
    const k1 = await session(
      key(agentKey, null),
      "2006-01-05T00:00:00Z",
      0.4,
      4,
      agentReleaseId,
    );
    // A profile the session moved to, and a session with none.
    await db
      .update(sessions)
      .set({ profileId: "claude-review-v1" })
      .where(eq(sessions.id, b1));
    await db
      .update(sessions)
      .set({ profileId: null })
      .where(eq(sessions.id, k1));

    const whole = await summary(user("owner", "owner"), {
      scope: "installation",
      ...period,
    });
    expect(whole).toMatchObject({ session_count: 4, cost_complete: false });
    for (const group_by of ["agent", "user", "profile"] as const) {
      const grouped = await summary(user("owner", "owner"), {
        scope: "installation",
        ...period,
        group_by,
      });
      const { groups, ...totals } = grouped;
      expect({ ...totals, refreshed_at: "" }).toEqual({
        ...whole,
        refreshed_at: "",
      });
      const sum = (pick: (g: NonNullable<typeof groups>[number]) => number) =>
        (groups ?? []).reduce((total, group) => total + pick(group), 0);
      expect(sum((g) => g.session_count)).toBe(whole.session_count);
      expect(sum((g) => g.run_seconds)).toBe(whole.run_seconds);
      expect(Math.round(sum((g) => Number(g.cost_usd)) * 1e6)).toBe(
        Math.round(Number(whole.cost_usd) * 1e6),
      );
      expect(groups?.some((g) => !g.cost_complete)).toBe(true);
    }
    // 60 + 1.5 + 1.5 + 60 seconds: the halves meet in the total's one floor.
    expect(whole.run_seconds).toBe(123);
    expect(
      (
        await summary(user("owner", "owner"), {
          scope: "installation",
          ...period,
          group_by: "agent",
        })
      ).groups,
    ).toEqual([
      {
        id: agentId,
        name: "Bot",
        session_count: 2,
        run_seconds: 61,
        cost_usd: "0.650000",
        cost_complete: true,
      },
      {
        id: null,
        name: null,
        session_count: 2,
        run_seconds: 62,
        cost_usd: "0.400000",
        cost_complete: false,
      },
    ]);
    const byUser = await summary(user("owner", "owner"), {
      scope: "installation",
      ...period,
      group_by: "user",
    });
    expect(
      byUser.groups?.map((g) => [g.id, g.name, g.session_count, g.cost_usd]),
    ).toEqual([
      [null, null, 1, "0.400000"],
      [ids.alice, "alice", 2, "0.350000"],
      [ids.bob, "bob", 1, "0.300000"],
    ]);
    const byProfile = await summary(user("owner", "owner"), {
      scope: "installation",
      ...period,
      group_by: "profile",
    });
    expect(
      byProfile.groups?.map((g) => [
        g.id,
        g.name,
        g.session_count,
        g.cost_usd,
        g.cost_complete,
      ]),
    ).toEqual([
      [null, null, 1, "0.400000", true],
      ["claude-coding-v1", "claude-coding-v1", 2, "0.350000", true],
      ["claude-review-v1", "claude-review-v1", 1, "0.300000", false],
    ]);
    // Under scope=me the profiles of the caller's sessions are named.
    expect(
      (
        await summary(bob, { scope: "me", ...period, group_by: "profile" })
      ).groups?.map((g) => [g.id, g.name, g.session_count]),
    ).toEqual([["claude-review-v1", "claude-review-v1", 1]]);

    // scope=me groups only the caller's own sessions.
    const mine = await summary(alice, {
      scope: "me",
      ...period,
      group_by: "user",
    });
    expect(mine.groups).toEqual([
      {
        id: ids.alice,
        name: "alice",
        session_count: 2,
        run_seconds: 3,
        cost_usd: "0.350000",
        cost_complete: true,
      },
    ]);
    expect(
      (
        await summary(alice, { scope: "me", ...period, group_by: "agent" })
      ).groups?.map((g) => [g.id, g.session_count]),
    ).toEqual([
      [agentId, 1],
      [null, 1],
    ]);
    // A period without sessions has no groups and zero totals.
    expect(
      await summary(bob, {
        scope: "me",
        since: "1999-01-01",
        until: "1999-02-01",
        group_by: "user",
      }),
    ).toMatchObject({
      session_count: 0,
      cost_usd: "0",
      run_seconds: 0,
      cost_complete: true,
      groups: [],
    });
  });

  test("group_by reads in the same statements whatever the number of groups", async () => {
    const statements: string[] = [];
    const reader = createPostgresUsageReader(
      drizzle(pool, {
        schema,
        logger: { logQuery: (query) => statements.push(query) },
      }),
    );
    const count = async (since: string, until: string) => {
      statements.length = 0;
      const read = await reader.usageSummaryGroups(
        { kind: "installation" },
        { since: new Date(since), until: new Date(until) },
        "user",
      );
      return { groups: read.groups.length, statements: statements.length };
    };
    const one = await count("2001-03-02T00:00:00Z", "2001-03-03T00:00:00Z");
    const many = await count("2001-01-01T00:00:00Z", "2007-01-01T00:00:00Z");
    expect(one.groups).toBe(1);
    expect(many.groups).toBeGreaterThan(2);
    expect(many.statements).toBe(one.statements);
  });

  test("since and until cut on UTC, since included and until not", async () => {
    const caller = user("alice", "member");
    await session(caller, "2005-09-30T23:59:59.999Z", 1, 1);
    await session(caller, "2005-10-01T00:00:00Z", 2, 1);
    await session(caller, "2005-10-31T23:59:59.999Z", 4, 1);
    await session(caller, "2005-11-01T00:00:00Z", 8, 1);

    for (const query of [
      { since: "2005-10-01", until: "2005-11-01" },
      { since: "2005-10-01T09:00:00+09:00", until: "2005-11-01T00:00:00Z" },
    ]) {
      expect(await summary(caller, { scope: "me", ...query })).toMatchObject({
        period: {
          since: "2005-10-01T00:00:00.000Z",
          until: "2005-11-01T00:00:00.000Z",
        },
        session_count: 2,
        cost_usd: "6.000000",
      });
    }
  });

  test("without until the period ends at the read, and an open turn runs until then", async () => {
    const caller = user("admin", "admin");
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const id = await session(caller, new Date().toISOString(), 0, 0);
    await setTurn(id, {
      status: "running",
      startedAt: new Date(Date.now() - 30_000),
      endedAt: null,
      resultJson: null,
    });

    const read = await summary(caller, { scope: "me", since });
    expect(read.period.until).toBe(read.refreshed_at);
    expect(read.session_count).toBe(1);
    expect(read.run_seconds).toBeGreaterThanOrEqual(30);
    expect(read.run_seconds).toBeLessThan(120);
    expect(read.cost_complete).toBe(false);
  });
});

// What the console does: signed in with a cookie, through the route's scope
// check and then the service's own (94S-864).
integration("installation figures over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let app: ReturnType<typeof createApiApp>;
  const workspaceId = crypto.randomUUID();
  const secret = crypto.randomUUID();
  const cookies = {} as Record<WorkspaceRole, string>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "usage_summary_http" });
    pool = new Pool({ connectionString: database.url, max: 5 });
    const db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(crypto.randomUUID()),
      lockout: new LoginLockout(),
    };
    app = createApiApp({
      authMode: "api-key",
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      authorization,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) =>
        registerUsageRoutes(
          router,
          createUsageService({
            authorization,
            reader: createPostgresUsageReader(db),
            limits: {
              executionSlotLimit: 10,
              queuedInputLimitPerSession: 20,
              storageLimitBytes: 1_073_741_824,
              maxTurnSeconds: 3600,
              sessionCostLimitUsd: 2.5,
              sessionTokenLimit: null,
              providerMaxRetries: 2,
            },
          }),
        ),
    });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    const hash = await Bun.password.hash(secret, { algorithm: "argon2id" });
    for (const role of ["owner", "admin", "member"] as const) {
      const [user] = await db
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          email: `${role}@example.com`,
          passwordHash: hash,
          displayName: role,
        })
        .returning({ id: users.id });
      if (!user) throw new Error("no user");
      await db
        .insert(memberships)
        .values({ workspaceId, userId: user.id, role });
      const login = await app.request("/v1/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "agent-platform-web",
        },
        body: JSON.stringify({
          email: `${role}@example.com`,
          password: secret,
        }),
      });
      expect(login.status).toBe(200);
      cookies[role] =
        (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const get = (path: string, role: WorkspaceRole) =>
    app.request(path, {
      headers: {
        Cookie: cookies[role],
        "X-Requested-With": "agent-platform-web",
      },
    });

  test("the owner reads GET /v1/limits and scope=installation; admin and member get 403", async () => {
    const installation =
      "/v1/usage/summary?scope=installation&since=2026-10-01";
    const tools = "/v1/usage/tools?scope=installation&since=2026-10-01";
    for (const [role, status] of [
      ["owner", 200],
      ["admin", 403],
      ["member", 403],
    ] as const) {
      for (const path of [
        "/v1/limits",
        "/v1/limits?scope=installation",
        installation,
        tools,
        "/v1/usage/outcomes?scope=installation&since=2026-10-01",
      ]) {
        const response = await get(path, role);
        expect(response.status, `${role} ${path}`).toBe(status);
        if (status === 403) {
          expect(
            apiErrorResponseSchema.parse(await response.json()).error.code,
          ).toBe("FORBIDDEN");
        }
      }
      // The per-session limits and their own figure are everyone's.
      const limits = await get("/v1/limits?scope=me", role);
      expect(limits.status, role).toBe(200);
      expect(memberLimitsResponseSchema.parse(await limits.json())).toEqual({
        scope: "me",
        refreshed_at: expect.any(String),
        limits: {
          queued_input_limit_per_session: expect.any(Number),
          max_turn_seconds: expect.any(Number),
          session_cost_limit_usd: expect.any(String),
          session_token_limit: null,
        },
      });
      const me = await get("/v1/usage/summary?scope=me&since=2026-10-01", role);
      expect(me.status, role).toBe(200);
      expect(usageSummaryResponseSchema.parse(await me.json())).toMatchObject({
        scope: "me",
        session_count: 0,
      });
      const myTools = await get(
        "/v1/usage/tools?scope=me&since=2026-10-01",
        role,
      );
      expect(myTools.status, role).toBe(200);
      expect(usageToolsResponseSchema.parse(await myTools.json())).toEqual({
        tools: [],
        findings: [],
      });
    }
  });
});
