import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type FinalizeRequest,
  TURN_BUDGET_EXCEEDED_REASON,
  type WorkerScope,
} from "@agent-platform/contracts";
import {
  createWorkerGateway,
  type InputLimits,
  type ProviderUsage,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { INSTALLATION_STORAGE_SCOPE } from "./input-limits.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  executions,
  MAX_SESSION_COST_USD,
  providerUsage,
  receipts,
  sessions,
  storageUsage,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const COST_LIMIT_USD = 10;
const roomy: InputLimits = {
  queuedInputLimitPerSession: 1_000,
  storageLimitBytes: Number.MAX_SAFE_INTEGER,
};
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

integration("installation limits on PostgreSQL (94S-131)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "limits_it" });
    pool = new Pool({ connectionString: database.url, max: 20 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read"],
            permission_mode: "default",
            provider: {
              kind: "litellm",
              endpoint: "https://litellm.invalid",
              auth: {
                kind: "api_key",
                value: "catalog-provider-key",
                ref: { value_env: "PROVIDER_KEY" },
              },
            },
          },
        },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["claude-coding-v1"],
          },
        },
      },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: COST_LIMIT_USD,
        leaseTtlMs: 30_000,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const inputs = () => createPostgresSessionUnitOfWork(db);
  const store = () =>
    createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: COST_LIMIT_USD,
      connectForLock: () => pool.connect(),
    });

  function create(
    ownerId: string,
    message: string,
    limits: InputLimits = roomy,
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return inputs().acceptInputAtomic({
      limits,
      principal: { ownerId },
      idempotencyKey,
      payloadHash: `hash-${message}`,
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message,
    });
  }

  function append(
    session: { session_id: string; ownerId: string },
    message: string,
    limits: InputLimits = roomy,
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return inputs().appendInputAtomic({
      limits,
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey,
      payloadHash: `hash-${message}`,
      message,
    });
  }

  async function queuedSession(partition = `p-${crypto.randomUUID()}`) {
    const ownerId = `owner-${crypto.randomUUID()}`;
    const result = await create(ownerId, "first input");
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, result.response.session_id));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, result.response.session_id));
    return { ...result.response, ownerId, partition };
  }

  async function storedBytes(): Promise<number> {
    const [row] = await db
      .select({ bytes: storageUsage.bytes })
      .from(storageUsage)
      .where(eq(storageUsage.scope, INSTALLATION_STORAGE_SCOPE));
    return Number(row?.bytes ?? 0);
  }

  async function spend(sessionId: string, costUsd: number) {
    await db
      .update(sessions)
      .set({ costUsd })
      .where(eq(sessions.id, sessionId));
  }

  function usage(counts: Partial<ProviderUsage>): ProviderUsage {
    return {
      model: "claude-sonnet-4-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 0,
      speed: "standard",
      webSearchRequests: 0,
      webFetchRequests: 0,
      codeExecutionRequests: 0,
      estimated: false,
      ...counts,
    };
  }

  async function sessionCost(sessionId: string): Promise<number> {
    const [row] = await db
      .select({ costUsd: sessions.costUsd })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row?.costUsd ?? Number.NaN;
  }

  async function launch(partition: string, sessionId: string) {
    const executionId = `exec-${crypto.randomUUID()}`;
    const registered = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      sessionId,
      backend: "local_docker",
    });
    if (registered.nonce === null) throw new Error("launch already registered");
    await db.insert(executions).values({
      backend: "local_docker",
      desiredState: "running",
      generation: 1,
      id: executionId,
      observedState: "running",
      sessionId,
    });
    await db
      .update(sessions)
      .set({ executionId })
      .where(eq(sessions.id, sessionId));
    return { executionId, nonce: registered.nonce, generation: 1 };
  }

  function claim(l: Awaited<ReturnType<typeof launch>>) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }

  type Claimed = Awaited<ReturnType<typeof claim>>;

  function scopeOf(
    claimed: Claimed,
    turnId: string | null = null,
  ): WorkerScope {
    return {
      session_id: claimed.session_id,
      turn_id: turnId,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    };
  }

  function principalOf(claimed: Claimed): WorkerPrincipal {
    return {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof WorkerGatewayError) {
        return { status: error.status, code: error.code };
      }
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  async function bound() {
    const session = await queuedSession();
    const l = await launch(session.partition, session.session_id);
    const claimed = await claim(l);
    return { session, claimed, launched: l };
  }

  function finalize(
    claimed: Claimed,
    turnId: string,
    overrides: Partial<FinalizeRequest> & { costUsd?: number | null } = {},
  ) {
    const { costUsd = 1.5, ...rest } = overrides;
    return gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, turnId),
      turn_id: turnId,
      finalize_key: `fin-${turnId}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
        cost_usd: costUsd,
      },
      checkpoint: null,
      ...rest,
    });
  }

  describe("queued input per session", () => {
    test("refuses the input past the limit, and still replays one it already took", async () => {
      const session = await queuedSession();
      const limits = { ...roomy, queuedInputLimitPerSession: 2 };
      const key = crypto.randomUUID();
      const second = await append(session, "second", limits, key);
      expect(second.outcome).toBe("accepted");

      expect(await append(session, "third", limits)).toEqual({
        outcome: "queue_full",
      });
      // Nothing was written for the refused input.
      const rows = await db
        .select({ id: turns.id })
        .from(turns)
        .where(eq(turns.sessionId, session.session_id));
      expect(rows).toHaveLength(2);

      const replay = await append(session, "second", limits, key);
      expect(replay.outcome).toBe("replayed");
    });

    test("counts only queued turns: a delivered one frees its place", async () => {
      const { session, claimed } = await bound();
      const limits = { ...roomy, queuedInputLimitPerSession: 1 };
      expect((await append(session, "blocked", limits)).outcome).toBe(
        "queue_full",
      );
      const next = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      expect(next.input?.turn_id).toBe("1");
      expect((await append(session, "now fits", limits)).outcome).toBe(
        "accepted",
      );
    });
  });

  describe("installation storage", () => {
    test("charges the UTF-8 bytes of each accepted message and refuses the one past the limit", async () => {
      const ownerId = `owner-${crypto.randomUUID()}`;
      const message = "안녕하세요";
      const size = Buffer.byteLength(message, "utf8");
      const before = await storedBytes();

      const exact = { ...roomy, storageLimitBytes: before + size };
      expect((await create(ownerId, message, exact)).outcome).toBe("accepted");
      expect(await storedBytes()).toBe(before + size);

      expect(await create(ownerId, message, exact)).toEqual({
        outcome: "storage_exhausted",
      });
      expect(await storedBytes()).toBe(before + size);
    });

    test("a turn written without the admission check is charged all the same", async () => {
      // What an API build from before the limit does during a rollout.
      const session = await queuedSession();
      const before = await storedBytes();
      await db.insert(turns).values({
        sessionId: session.session_id,
        sequence: 2,
        message: "written by an old build",
        status: "queued",
      });
      expect(await storedBytes()).toBe(
        before + Buffer.byteLength("written by an old build"),
      );
    });

    test("a replay is answered even when storage is full", async () => {
      const ownerId = `owner-${crypto.randomUUID()}`;
      const key = crypto.randomUUID();
      const first = await create(ownerId, "kept", roomy, key);
      expect(first.outcome).toBe("accepted");
      const full = { ...roomy, storageLimitBytes: 1 };
      expect((await create(ownerId, "kept", full, key)).outcome).toBe(
        "replayed",
      );
    });

    test("concurrent acceptances racing for the last bytes admit exactly what fits", async () => {
      const ownerId = `owner-${crypto.randomUUID()}`;
      const message = "x".repeat(10);
      const before = await storedBytes();
      const limits = { ...roomy, storageLimitBytes: before + 3 * 10 };

      const results = await Promise.all(
        Array.from({ length: 12 }, () => create(ownerId, message, limits)),
      );

      const outcomes = results.map((result) => result.outcome).sort();
      expect(outcomes.filter((o) => o === "accepted")).toHaveLength(3);
      expect(outcomes.filter((o) => o === "storage_exhausted")).toHaveLength(9);
      expect(await storedBytes()).toBe(before + 30);
    }, 30_000);
  });

  describe("session cost budget", () => {
    test("finalize keeps the engine's figure on the turn and adds nothing to the session (94S-409)", async () => {
      const { session, claimed } = await bound();
      await gateway.nextInput(principalOf(claimed), scopeOf(claimed));

      await finalize(claimed, "1");
      await finalize(claimed, "1");

      expect(await sessionCost(session.session_id)).toBe(0);
      const [turn] = await db
        .select({ result: turns.resultJson })
        .from(turns)
        .where(eq(turns.sessionId, session.session_id));
      expect(turn?.result).toMatchObject({ cost_usd: 1.5 });
    });

    test("a metered call is priced and added once; a replay adds nothing and a changed one is refused (94S-409)", async () => {
      const { session, claimed } = await bound();
      const exchangeId = crypto.randomUUID();
      const report = {
        exchangeId,
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        usage: usage({ inputTokens: 1_000, outputTokens: 100 }),
      };

      // claude-sonnet-4-5: $3 in and $15 out per million tokens.
      expect(await gateway.recordProviderUsage(report)).toEqual({
        costUsd: 0.0045,
        pricedBy: "table",
      });
      await gateway.recordProviderUsage(report);
      expect(await sessionCost(session.session_id)).toBe(0.0045);
      expect(
        await failure(
          gateway.recordProviderUsage({
            ...report,
            usage: usage({ inputTokens: 1_000, outputTokens: 101 }),
          }),
        ),
      ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
      const rows = await db
        .select({ costUsd: providerUsage.costUsd })
        .from(providerUsage)
        .where(eq(providerUsage.exchangeId, exchangeId));
      expect(rows).toEqual([{ costUsd: 0.0045 }]);
    });

    test("a call is charged to its session after its attempt ended, and never to another session's attempt (94S-409)", async () => {
      const { session, claimed, launched } = await bound();
      const other = await bound();
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "drained",
      });
      await gateway.confirmExecutionGone(launched.executionId);

      await gateway.recordProviderUsage({
        exchangeId: crypto.randomUUID(),
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        usage: usage({ outputTokens: 1_000_000 }),
      });
      expect(await sessionCost(session.session_id)).toBe(15);

      expect(
        await failure(
          gateway.recordProviderUsage({
            exchangeId: crypto.randomUUID(),
            sessionId: session.session_id,
            attemptId: other.claimed.attempt_id,
            usage: usage({ outputTokens: 1 }),
          }),
        ),
      ).toEqual({ status: 404, code: "NOT_FOUND" });
      expect(await sessionCost(other.session.session_id)).toBe(0);
    });

    test("a model the table does not know is charged at the highest known rates (94S-409)", async () => {
      const { session, claimed } = await bound();
      const priced = await gateway.recordProviderUsage({
        exchangeId: crypto.randomUUID(),
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        usage: usage({ model: "some-alias", outputTokens: 1_000_000 }),
      });
      expect(priced.pricedBy).toBe("fallback");
      expect(priced.costUsd).toBeGreaterThanOrEqual(50);
      const [row] = await db
        .select({ pricedBy: providerUsage.pricedBy })
        .from(providerUsage)
        .where(eq(providerUsage.sessionId, session.session_id));
      expect(row?.pricedBy).toBe("fallback");
    });

    test("a fast call with web searches is priced at the fast rate plus the search fee, and the row says why (94S-451)", async () => {
      const { session, claimed } = await bound();
      const exchangeId = crypto.randomUUID();
      const report = {
        exchangeId,
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        // claude-opus-5 fast: $50 out per million; two searches at $0.01.
        usage: usage({
          model: "claude-opus-5",
          speed: "fast",
          outputTokens: 1_000,
          webSearchRequests: 2,
          codeExecutionRequests: 1,
        }),
      };
      expect(await gateway.recordProviderUsage(report)).toEqual({
        costUsd: 0.07,
        pricedBy: "table",
      });
      expect(
        await failure(
          gateway.recordProviderUsage({
            ...report,
            usage: { ...report.usage, speed: "standard" },
          }),
        ),
      ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
      const rows = await db
        .select({
          speed: providerUsage.speed,
          webSearchRequests: providerUsage.webSearchRequests,
          codeExecutionRequests: providerUsage.codeExecutionRequests,
          costUsd: providerUsage.costUsd,
        })
        .from(providerUsage)
        .where(eq(providerUsage.exchangeId, exchangeId));
      expect(rows).toEqual([
        {
          speed: "fast",
          webSearchRequests: 2,
          codeExecutionRequests: 1,
          costUsd: 0.07,
        },
      ]);
      expect(await sessionCost(session.session_id)).toBe(0.07);
    });

    test("a turn the engine cut on its budget says why, and the metered sum is what holds the next poll (94S-279)", async () => {
      const { session, claimed } = await bound();
      await append(session, "second");
      await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
      const cut: Partial<FinalizeRequest> = {
        terminal: {
          status: "failed",
          reason: TURN_BUDGET_EXCEEDED_REASON,
          result: { subtype: "error_max_budget_usd", is_error: true },
          usage: null,
          cost_usd: 10.25,
        },
      };

      await finalize(claimed, "1", cut);
      await finalize(claimed, "1", cut);

      const [turn] = await db
        .select({ status: turns.status, reason: turns.terminalReason })
        .from(turns)
        .where(
          and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
        );
      expect(turn).toEqual({ status: "failed", reason: "budget_exceeded" });
      const [receipt] = await db
        .select({ status: receipts.status, error: receipts.error })
        .from(receipts)
        .where(
          and(
            sql`${receipts.targetRef}->>'session_id' = ${session.session_id}`,
            eq(receipts.status, "failed"),
          ),
        );
      expect(receipt).toMatchObject({
        status: "failed",
        error: { code: "BUDGET_EXCEEDED", message: "budget_exceeded" },
      });
      // The calls that spent it, as the proxy metered them: $10.5.
      await gateway.recordProviderUsage({
        exchangeId: crypto.randomUUID(),
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        usage: usage({ outputTokens: 700_000 }),
      });
      expect(
        await gateway.nextInput(principalOf(claimed), scopeOf(claimed)),
      ).toMatchObject({ input: null, reason: "BUDGET_EXCEEDED" });
    });

    test("every claim hands the engine what is left, so a resumed attempt gets less (94S-279)", async () => {
      const { session, claimed, launched } = await bound();
      expect(claimed.remaining_budget_usd).toBe(COST_LIMIT_USD);
      // Spent without delivering a turn: a delivered turn no checkpoint covers would hold the session back from the next claim (94S-288).
      await spend(session.session_id, 4.25);
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "drained",
      });
      await gateway.confirmExecutionGone(launched.executionId);
      // It never asked for input, so it counts as a failed startup (94S-347).
      await db
        .update(sessions)
        .set({ restoreRetryAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(sessions.id, session.session_id));

      const again = await claim(
        await launch(session.partition, session.session_id),
      );

      expect(again.attempt_id).not.toBe(claimed.attempt_id);
      expect(again.remaining_budget_usd).toBe(COST_LIMIT_USD - 4.25);
    });

    test("a cost below a micro-dollar still counts, rounded up", async () => {
      const { session, claimed } = await bound();

      // One cache-read token at $0.30 per million.
      await gateway.recordProviderUsage({
        exchangeId: crypto.randomUUID(),
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        usage: usage({ cacheReadInputTokens: 1 }),
      });

      // The ledger holds what the session was charged, so the two add up.
      expect(await sessionCost(session.session_id)).toBe(0.000001);
      const [row] = await db
        .select({ costUsd: providerUsage.costUsd })
        .from(providerUsage)
        .where(eq(providerUsage.sessionId, session.session_id));
      expect(row?.costUsd).toBe(0.000001);
    });

    test("a sum or a call past what the column holds saturates instead of failing the report (Codex R1)", async () => {
      const { session, claimed } = await bound();
      await gateway.recordProviderUsage({
        exchangeId: crypto.randomUUID(),
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        usage: usage({ outputTokens: Number.MAX_SAFE_INTEGER }),
      });
      expect(await sessionCost(session.session_id)).toBe(MAX_SESSION_COST_USD);
      await spend(session.session_id, MAX_SESSION_COST_USD - 1);

      await gateway.recordProviderUsage({
        exchangeId: crypto.randomUUID(),
        sessionId: session.session_id,
        attemptId: claimed.attempt_id,
        usage: usage({ outputTokens: 1_000_000 }),
      });

      expect(await sessionCost(session.session_id)).toBe(MAX_SESSION_COST_USD);
    });

    test("a spent session gets no new turn and is told why; the input still queues", async () => {
      const { session, claimed } = await bound();
      await spend(session.session_id, COST_LIMIT_USD);

      const next = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      expect(next).toMatchObject({
        input: null,
        draining: true,
        reason: "BUDGET_EXCEEDED",
      });
      const [turn] = await db
        .select({ status: turns.status })
        .from(turns)
        .where(eq(turns.sessionId, session.session_id));
      expect(turn?.status).toBe("queued");

      expect((await append(session, "later")).outcome).toBe("accepted");
    });

    test("a turn the attempt already holds is redelivered even after the budget is spent", async () => {
      const { session, claimed } = await bound();
      const first = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      expect(first.input?.turn_id).toBe("1");
      await spend(session.session_id, COST_LIMIT_USD + 1);

      const again = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      expect(again.input?.turn_id).toBe("1");
      expect(again.draining).toBeUndefined();
    });

    test("a spent session is not claimed, demanded or reserved", async () => {
      const spent = await queuedSession();
      await spend(spent.session_id, COST_LIMIT_USD);
      const l = await launch(spent.partition, spent.session_id);
      expect(await failure(claim(l))).toEqual({
        status: 404,
        code: "NOT_FOUND",
      });

      const under = await queuedSession();
      await spend(under.session_id, COST_LIMIT_USD - 0.01);
      const demand = await store().inspectDemand({ limit: 1_000 });
      expect(demand.eligibleSessionIds).not.toContain(spent.session_id);
      expect(demand.eligibleSessionIds).toContain(under.session_id);

      const other = await queuedSession();
      await spend(other.session_id, COST_LIMIT_USD);
      expect(
        await store().reserveLaunch({
          backend: "local_docker",
          image: "sha256:worker",
          now: new Date(),
          resources: {
            cpus: 1,
            memoryBytes: 512 * 1024 * 1024,
            pidsLimit: 256,
          },
          sessionId: other.session_id,
          slotLimit: 1_000,
        }),
      ).toBeNull();
    });
  });
});
