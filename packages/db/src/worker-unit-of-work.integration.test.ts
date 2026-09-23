import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerEvent, WorkerScope } from "@agent-platform/contracts";
import {
  createWorkerGateway,
  DEFAULT_NONCE_TTL_MS,
  hashWorkerToken,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { and, count, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresCheckpointStore } from "./checkpoint-store.ts";
import { pauseBlocker } from "./pause-control.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { reconcileOrphanedSessions } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  checkpoints,
  events,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
  workers,
} from "./schema.ts";
import {
  CHECKPOINT_RESTORE_FALLBACK,
  createPostgresWorkerUnitOfWork,
} from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LEASE_TTL_MS = 2_000;
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

integration("worker gateway on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let clock = new Date("2026-09-22T00:00:00.000Z");
  const now = () => clock;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "worker_gw_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
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
        async verify({ checkpoint }) {
          return checkpoint.manifest_ref.startsWith("bad/")
            ? { status: "rejected", reason: "hash mismatch" }
            : { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        leaseTtlMs: LEASE_TTL_MS,
        now,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const briefGateway = (leaseTtlMs: number) =>
    createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
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
        sessionCostLimitUsd: 1_000,
        leaseTtlMs,
        now: () => clock,
        sleep: async () => {},
      },
    });

  async function launch(partition: string, sessionId?: string) {
    const executionId = `exec-${crypto.randomUUID()}`;
    const registered = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      ...(sessionId === undefined ? {} : { sessionId }),
      backend: "local_docker",
    });
    if (registered.nonce === null) throw new Error("launch already registered");
    return { executionId, nonce: registered.nonce, generation: 1 };
  }

  // Every test owns a partition so leftovers from other tests never compete.
  async function queuedSession(partition: string, message = "first input") {
    const result = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: `owner-${crypto.randomUUID()}` },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message,
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, result.response.session_id));
    return result.response;
  }

  function partitionFor(name: string) {
    return `${name}-${crypto.randomUUID()}`;
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Lease and token expiry are judged on the database clock, so assertions
  // about them bracket the call with that clock, never the injected one.
  async function dbNowMs() {
    const [row] = await db
      .select({
        ms: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`,
      })
      .from(sql`(SELECT 1) AS one`);
    return Number(row?.ms);
  }

  // A gateway whose request clock runs `offsetMs` from this machine's: the
  // replica-skew case the database clock exists to make irrelevant.
  const skewedGateway = (offsetMs: number, leaseTtlMs: number) =>
    createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
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
        sessionCostLimitUsd: 1_000,
        leaseTtlMs,
        now: () => new Date(Date.now() + offsetMs),
        sleep: async () => {},
      },
    });

  function claim(l: Awaited<ReturnType<typeof launch>>) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }

  function scopeOf(
    claimed: Awaited<ReturnType<typeof claim>>,
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

  function principalOf(
    claimed: Awaited<ReturnType<typeof claim>>,
  ): WorkerPrincipal {
    return {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
  }

  function fenceOf(claimed: Awaited<ReturnType<typeof claim>>) {
    const { kind: _kind, ...fence } = principalOf(claimed) as Extract<
      WorkerPrincipal,
      { kind: "session" }
    >;
    return fence;
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

  function event(sourceSequence: number): WorkerEvent {
    return {
      event: "status",
      data: { phase: "running" },
      source_sequence: sourceSequence,
      occurred_at: clock.toISOString(),
    };
  }

  // Runs a full attempt so later tests start from a clean queue head.
  async function claimAndDeliver(partition = partitionFor("run")) {
    const session = await queuedSession(partition);
    const l = await launch(partition);
    const claimed = await claim(l);
    expect(claimed.session_id).toBe(session.session_id);
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    if (!next.input) throw new Error("no input delivered");
    return { session, launch: l, claimed, input: next.input };
  }

  test("bootstrapClaim binds one unassigned session per launch and replays the same binding", async () => {
    const partition = partitionFor("bind");
    const session = await queuedSession(partition);
    const l = await launch(partition);
    const first = await claim(l);
    expect(first.session_id).toBe(session.session_id);
    expect(first.lease_epoch).toBe(1);
    expect(first.execution_generation).toBe(1);
    expect(first.runtime).toEqual({
      kind: "claude_agent_sdk",
      version: "0.3.270",
      profile_id: "claude-coding-v1",
    });
    expect(first.restore).toBeNull();
    expect(first.session_credential.startsWith("wsc_")).toBe(true);
    // The repository comes from the row, bound only because the catalog
    // still registers that id at that URL and branch for this profile. The
    // profile comes from the catalog, resolved at claim time.
    expect(first.workspace).toEqual({
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
    });
    expect(first.runtime_config).toEqual({
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "default",
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: { kind: "api_key", value: "catalog-provider-key" },
      },
    });

    const retry = await claim(l);
    expect(retry.session_id).toBe(first.session_id);
    expect(retry.attempt_id).toBe(first.attempt_id);
    expect(retry.lease_epoch).toBe(first.lease_epoch);
    expect(retry.session_credential).not.toBe(first.session_credential);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.podId).toBe(l.executionId);
    expect(row?.executionId).toBe(l.executionId);
    const signals = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(signals).toHaveLength(0);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, first.attempt_id));
    expect(attempt?.state).toBe("allocated");
    // The replayed claim rotated the token: only the latest one resolves.
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(first.session_credential)),
    ).toBeNull();
    expect(
      await work.resolveCredential(hashWorkerToken(retry.session_credential)),
    ).toEqual({
      kind: "session",
      attemptId: first.attempt_id,
      sessionId: first.session_id,
      leaseEpoch: retry.lease_epoch,
      executionGeneration: retry.execution_generation,
      authRevision: retry.auth_revision,
    });
  });

  test("a nonce is rejected for another execution identity, when expired, and when unknown", async () => {
    const partition = partitionFor("nonce");
    await queuedSession(partition);
    const l = await launch(partition);
    expect(
      await failure(
        gateway.bootstrapClaim(bootstrap, {
          execution_id: "someone-else",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    expect(
      await failure(
        gateway.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: 2,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    expect(
      await failure(
        gateway.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "wln_unknown" },
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    await db
      .update(workerLaunches)
      .set({ nonceExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  test("two launches racing for one session: exactly one binds, the other waits", async () => {
    const partition = partitionFor("race");
    await queuedSession(partition);
    const [a, b] = await Promise.all([launch(partition), launch(partition)]);
    const results = await Promise.allSettled([claim(a), claim(b)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(WorkerGatewayError);
    expect(reason.code).toBe("NOT_FOUND");
  });

  test("the same nonce presented by two workers concurrently yields one binding and one live token", async () => {
    const partition = partitionFor("leak");
    await queuedSession(partition);
    const l = await launch(partition);
    const [x, y] = await Promise.all([claim(l), claim(l)]);
    expect(x.attempt_id).toBe(y.attempt_id);
    expect(x.session_id).toBe(y.session_id);
    const work = createPostgresWorkerUnitOfWork(db);
    const live = (
      await Promise.all(
        [x, y].map((c) =>
          work.resolveCredential(hashWorkerToken(c.session_credential)),
        ),
      )
    ).filter(Boolean);
    expect(live).toHaveLength(1);
  });

  test("bootstrap credentials cannot call post-claim methods, nor can a token for another binding", async () => {
    const { claimed } = await claimAndDeliver();
    expect(
      await failure(gateway.nextInput(bootstrap, scopeOf(claimed))),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    const other = await claimAndDeliver();
    expect(
      await failure(
        gateway.heartbeat(principalOf(other.claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("nextInput delivers the FIFO head once, records delivery_started_at and redelivers to the same attempt", async () => {
    const { session, claimed, input } = await claimAndDeliver();
    expect(input.turn_id).toBe("1");
    expect(input.message).toBe("first input");
    const [turn] = await db
      .select()
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(turn?.status).toBe("running");
    expect(turn?.attemptId).toBe(claimed.attempt_id);
    expect(turn?.deliveryStartedAt?.toISOString()).toBe(
      input.delivery_started_at,
    );
    const [message] = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, session.session_id));
    expect(message?.claimedBy).toBe(claimed.attempt_id);
    const [row] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.status).toBe("running");

    advance(500);
    const again = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    expect(again.input).toEqual(input);
  });

  test("heartbeat extends the lease and answers 409 LEASE_EXPIRED once the TTL passed", async () => {
    const partition = partitionFor("beat");
    await queuedSession(partition);
    const l = await launch(partition);
    const brief = briefGateway(400);
    const claimed = await brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    await brief.nextInput(principalOf(claimed), { ...scopeOf(claimed) });
    const before = new Date(claimed.lease_expires_at).getTime();
    await sleep(100);
    const floor = await dbNowMs();
    advance(1_000);
    const beat = await brief.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    const ceiling = await dbNowMs();
    const extended = new Date(beat.lease_expires_at).getTime();
    // The new deadline is the database clock plus the TTL, not the request
    // clock the gateway was handed.
    expect(extended).toBeGreaterThanOrEqual(floor + 400);
    expect(extended).toBeLessThanOrEqual(ceiling + 400);
    expect(extended).toBeGreaterThan(before);
    expect(beat.auth_revision).toBe(0);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    // Audit stamps still record the request clock.
    expect(attempt?.lastHeartbeatAt?.toISOString()).toBe(clock.toISOString());
    expect(attempt?.state).toBe("running");

    // The request clock does not move: only real time ends the lease.
    await sleep(450);
    expect(
      await failure(
        brief.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    expect(
      await failure(
        brief.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          batch_key: "b1",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    // Giving the binding up is still allowed on the current epoch.
    expect(
      await brief.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "lease_lost",
      }),
    ).toEqual({ released: true });
  });

  test("appendEvents dedups on (attempt_id, source_sequence); a re-sent batch is a no-op", async () => {
    const { session, claimed } = await claimAndDeliver();
    const request = {
      ...scopeOf(claimed, "1"),
      batch_key: "batch-1",
      events: [event(1), event(2)],
    };
    const first = await gateway.appendEvents(principalOf(claimed), request);
    expect(first.accepted_through).toBe(2);
    const second = await gateway.appendEvents(principalOf(claimed), request);
    expect(second).toEqual(first);
    const [storedRow] = await db
      .select({ stored: count() })
      .from(events)
      .where(eq(events.sessionId, session.session_id));
    expect(storedRow?.stored).toBe(2);
    const [row] = await db
      .select()
      .from(events)
      .where(eq(events.sessionId, session.session_id))
      .limit(1);
    expect(row?.attemptId).toBe(claimed.attempt_id);
    expect(row?.turnId).not.toBeNull();
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...request,
          turn_id: "42",
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("a nonce stops working once its lifetime passes, including on the replay path", async () => {
    const partition = partitionFor("expiry");
    await queuedSession(partition);
    const l = await launch(partition);
    const first = await claim(l);
    // The attempt is alive, but the bootstrap door closes with the nonce.
    await db
      .update(workerLaunches)
      .set({ nonceExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    // The running worker keeps the token it already holds.
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(first.session_credential)),
    ).not.toBeNull();
  });

  test("a claim is refused once the backend has taken the launch slot back", async () => {
    const partition = partitionFor("slotgone");
    await queuedSession(partition);
    const l = await launch(partition);
    // The execution died before claiming; the backend observed it.
    expect(await gateway.confirmExecutionGone(l.executionId)).toEqual({
      sessionReleased: false,
      slotReleased: true,
    });
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  test("registerLaunch hands out a nonce only when it registered the execution", async () => {
    const partition = partitionFor("reg");
    const executionId = `exec-${crypto.randomUUID()}`;
    const first = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      backend: "local_docker",
    });
    expect(first.outcome).toBe("registered");
    expect(first.nonce).not.toBeNull();
    const again = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      backend: "local_docker",
    });
    // The stored hash still belongs to the first nonce, so handing back a
    // freshly generated one would only produce claims that never work.
    expect(again).toEqual({ nonce: null, outcome: "exists" });
  });

  test("events are refused for a turn this attempt is not running", async () => {
    const partition = partitionFor("foreign");
    const session = await queuedSession(partition);
    const owner = (
      await db
        .select({ ownerId: sessions.ownerId })
        .from(sessions)
        .where(eq(sessions.id, session.session_id))
    )[0];
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: owner?.ownerId ?? "" },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "queued behind the head",
    });
    const l = await launch(partition);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    // Turn 2 exists and belongs to the session, but no attempt runs it.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "2"),
          batch_key: "b",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    // An id past the integer column is not found, not a database error.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "9999999999"),
          batch_key: "b",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...scopeOf(claimed, "9999999999"),
          turn_id: "9999999999",
          finalize_key: "f",
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: null,
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("reusing a source_sequence with different content is a conflict, not a silent drop", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = {
      ...scopeOf(claimed, "1"),
      batch_key: "batch-1",
      events: [event(1)],
    };
    await gateway.appendEvents(principalOf(claimed), base);
    const changed: WorkerEvent = {
      event: "status",
      data: { phase: "needs_input" },
      source_sequence: 1,
      occurred_at: clock.toISOString(),
    };
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [changed],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // A batch that extends the stream around a matching replay still lands.
    const extended = await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(1), event(2)],
    });
    expect(extended.accepted_through).toBe(2);
    // A batch that skips ahead is refused, not buffered: subscribers read the
    // stream back in the order it was written, so a hole would be permanent.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(4)],
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    const closed = await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(3), event(4)],
    });
    expect(closed.accepted_through).toBe(4);
    const [storedRow] = await db
      .select({ stored: count() })
      .from(events)
      .where(eq(events.sessionId, session.session_id));
    expect(storedRow?.stored).toBe(4);
  });

  test("finalize replayed with the same key but a different terminal is a conflict", async () => {
    const { claimed } = await claimAndDeliver();
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: { text: "done" },
        usage: null,
      },
      checkpoint: null,
    };
    const done = await gateway.finalize(principalOf(claimed), request);
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          terminal: {
            status: "failed",
            reason: "different story",
            result: null,
            usage: null,
          },
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // The stored terminal is what a true replay answers with.
    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(done);
  });

  test("interrupted stops the session, outcome_unknown blocks it for recovery", async () => {
    const interrupted = await claimAndDeliver();
    await gateway.finalize(principalOf(interrupted.claimed), {
      ...scopeOf(interrupted.claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "interrupted",
        reason: "user_stop",
        result: null,
        usage: null,
      },
      // An interrupted terminal is only taken with the checkpoint it stopped at.
      checkpoint: {
        revision: 0,
        manifest_ref: "manifests/interrupted.json",
        manifest_sha256: "d".repeat(64),
      },
    });
    const [stopped] = await db
      .select({
        status: sessions.status,
        admissionState: sessions.admissionState,
      })
      .from(sessions)
      .where(eq(sessions.id, interrupted.session.session_id));
    // DESIGN §6.6: an interrupt never takes the success/idle path.
    expect(stopped).toEqual({ status: "stopped", admissionState: "active" });
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, interrupted.session.session_id)),
    ).toHaveLength(0);

    const unknown = await claimAndDeliver();
    await gateway.finalize(principalOf(unknown.claimed), {
      ...scopeOf(unknown.claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "outcome_unknown",
        reason: "sdk_vanished",
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    const [blocked] = await db
      .select({
        status: sessions.status,
        admissionState: sessions.admissionState,
      })
      .from(sessions)
      .where(eq(sessions.id, unknown.session.session_id));
    expect(blocked).toEqual({
      status: "failed",
      admissionState: "recovery_required",
    });
    const [turn] = await db
      .select({ status: turns.status, outcomeUnknown: turns.outcomeUnknown })
      .from(turns)
      .where(eq(turns.sessionId, unknown.session.session_id));
    expect(turn).toEqual({ status: "outcome_unknown", outcomeUnknown: true });
    // The input stays on the queue until an operator decides (94S-140), and
    // no attempt is handed it again.
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, unknown.session.session_id)),
    ).toHaveLength(1);
    const [receipt] = await db
      .select({ status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, unknown.session.receipt_id));
    expect(receipt?.status).toBe("unknown");
    const again = await gateway.nextInput(
      principalOf(unknown.claimed),
      scopeOf(unknown.claimed),
    );
    expect(again.input).toBeNull();
  });

  test("the pod-based orphan reconciler leaves a gateway-bound session alone", async () => {
    const partition = partitionFor("reconcile");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "idle_timeout",
    });
    // The legacy reconciler keys on a missing/stale workers row. Left to it,
    // it would clear pod_id and requeue while the execution may still run.
    const reconciled = await reconcileOrphanedSessions(db, {
      now: new Date(clock.getTime() + 60_000),
    });
    expect(reconciled.map((row) => row.sessionId)).not.toContain(
      session.session_id,
    );
    const [row] = await db
      .select({ podId: sessions.podId, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.podId).toBe(l.executionId);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.session_id)),
    ).toHaveLength(0);
    // Sanity: a pod-lifecycle session (no execution_id) is still reconciled.
    const legacy = await queuedSession(partitionFor("legacy"));
    await db
      .update(sessions)
      .set({ podId: `pod-${crypto.randomUUID()}` })
      .where(eq(sessions.id, legacy.session_id));
    const legacyRun = await reconcileOrphanedSessions(db, {
      now: new Date(clock.getTime() + 60_000),
    });
    expect(legacyRun.map((r) => r.sessionId)).toContain(legacy.session_id);
    await db.delete(workers).where(eq(workers.podId, l.executionId));
  });

  test("a claim replay is refused once the attempt has used its token", async () => {
    const partition = partitionFor("used");
    await queuedSession(partition);
    const l = await launch(partition);
    const first = await claim(l);
    // nextInput is the worker using the binding: the claim response was not
    // lost, so a further exchange is someone else rotating the token away.
    await gateway.nextInput(principalOf(first), scopeOf(first));
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(first.session_credential)),
    ).not.toBeNull();
  });

  test("finalize cannot close a turn short of its event tail (94S-218)", async () => {
    const { session, claimed } = await claimAndDeliver();
    const scope = scopeOf(claimed, "1");
    await gateway.appendEvents(principalOf(claimed), {
      ...scope,
      batch_key: "b1",
      events: [event(1)],
    });
    const request = {
      ...scope,
      turn_id: "1",
      finalize_key: "fin-tail",
      final_source_sequence: 2,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    };
    // Event 2 is still in flight: the turn stays open.
    expect(
      await failure(gateway.finalize(principalOf(claimed), request)),
    ).toEqual({ status: 409, code: "REVISION_CONFLICT" });
    // Claiming less than is stored is refused the same way.
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          final_source_sequence: 0,
        }),
      ),
    ).toEqual({ status: 409, code: "REVISION_CONFLICT" });
    const [open] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(open?.status).toBe("running");

    await gateway.appendEvents(principalOf(claimed), {
      ...scope,
      batch_key: "b2",
      events: [event(2)],
    });
    const done = await gateway.finalize(principalOf(claimed), request);
    expect(done.status).toBe("completed");
    // A retry of the finalize that went through is still a replay.
    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(done);
    // One naming another tail is not: the gate ran for the first one only.
    for (const other of [0, 100]) {
      expect(
        await failure(
          gateway.finalize(principalOf(claimed), {
            ...request,
            final_source_sequence: other,
          }),
        ),
      ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    }
  });

  test("append and finalize racing in either order never lose the tail (94S-218)", async () => {
    for (const round of [0, 1, 2, 3, 4, 5]) {
      const { session, claimed } = await claimAndDeliver();
      const scope = scopeOf(claimed, "1");
      const request = {
        ...scope,
        turn_id: "1",
        finalize_key: `race-${round}`,
        final_source_sequence: 2,
        terminal: {
          status: "completed" as const,
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      };
      const append = () =>
        gateway.appendEvents(principalOf(claimed), {
          ...scope,
          batch_key: `race-${round}`,
          events: [event(1), event(2)],
        });
      const finalize = () =>
        gateway.finalize(principalOf(claimed), request).then(
          () => "finalized" as const,
          (error: unknown) => {
            if (
              error instanceof WorkerGatewayError &&
              error.code === "REVISION_CONFLICT"
            ) {
              return "refused" as const;
            }
            throw error;
          },
        );
      // Alternate which request is sent first; the session lock decides.
      const [first] =
        round % 2 === 0
          ? await Promise.all([finalize(), append()])
          : await Promise.all([append(), finalize()]).then(
              ([, verdict]) => [verdict] as const,
            );
      // The append always lands: a finalize never closed the turn on it.
      if (first === "refused") {
        expect(await finalize()).toBe("finalized");
      }
      const [stored] = await db
        .select({ n: count() })
        .from(events)
        .where(eq(events.sessionId, session.session_id));
      expect(stored?.n).toBe(2);
      const [closed] = await db
        .select({ status: turns.status })
        .from(turns)
        .where(
          and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
        );
      expect(closed?.status).toBe("completed");
    }
  });

  test("a rejected batch leaves the stream untouched and a closed turn takes no new events", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = { ...scopeOf(claimed, "1"), batch_key: "b" };
    await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(1)],
    });
    const changed: WorkerEvent = {
      event: "status",
      data: { phase: "idle" },
      source_sequence: 1,
      occurred_at: clock.toISOString(),
    };
    // A batch that mixes a conflicting replay with a new event must not
    // store the new one on its way to being rejected.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [changed, event(2)],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // Two different events under one sequence in a single batch.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(3), { ...changed, source_sequence: 3 }],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // The same sequence moved to another turn is not the same event.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          turn_id: null,
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const [afterRejects] = await db
      .select({ stored: count() })
      .from(events)
      .where(eq(events.sessionId, session.session_id));
    expect(afterRejects?.stored).toBe(1);

    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 1,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    // An exact replay still answers, a new event does not.
    expect(
      (
        await gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(1)],
        })
      ).accepted_through,
    ).toBe(1);
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(2)],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const [afterFinalize] = await db
      .select({ stored: count() })
      .from(events)
      .where(eq(events.sessionId, session.session_id));
    expect(afterFinalize?.stored).toBe(1);
  });

  test("a batch that does not continue the durable prefix is refused", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = { ...scopeOf(claimed, "1"), batch_key: "b" };
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(2), event(3)],
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    const [empty] = await db
      .select({ stored: count() })
      .from(events)
      .where(eq(events.sessionId, session.session_id));
    expect(empty?.stored).toBe(0);
    // Inside one batch the order of arrival does not matter: the rows are
    // written by source_sequence, which is the order they are read back in.
    const ordered = await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(3), event(1), event(2)],
    });
    expect(ordered.accepted_through).toBe(3);
    const stored = await db
      .select({ sourceSequence: events.sourceSequence })
      .from(events)
      .where(eq(events.sessionId, session.session_id))
      .orderBy(events.id);
    expect(stored.map((row) => row.sourceSequence)).toEqual([1, 2, 3]);
  });

  test("a draining attempt is not handed the next input", async () => {
    const partition = partitionFor("drain");
    const { session, claimed } = await claimAndDeliver(partition);
    const scope = scopeOf(claimed, "1");
    await gateway.finalize(principalOf(claimed), {
      ...scope,
      turn_id: "1",
      finalize_key: "drain-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    const [owner] = await db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: owner?.ownerId ?? "" },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "input the worker will not take",
    });
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "draining",
    });
    // The worker is on its way out, so the queued turn waits for the next
    // attempt instead of being delivered and then abandoned — and the poll
    // says so at once rather than holding the shutdown for its full wait.
    const polled = Date.now();
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
      wait_ms: 5_000,
    });
    expect(next.input).toBeNull();
    expect(Date.now() - polled).toBeLessThan(2_000);
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("draining");
    const [waiting] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 2)),
      );
    expect(waiting?.status).toBe("queued");
  });

  test("a heartbeat that commits late cannot shorten a lease already extended", async () => {
    const { claimed } = await claimAndDeliver();
    advance(500);
    const ahead = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    const extended = new Date(ahead.lease_expires_at).getTime();
    const heartbeatAt = clock.getTime();
    // An overlapping heartbeat carrying an older request timestamp lands
    // second; it must not undo what the first one committed.
    advance(-400);
    const late = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    expect(new Date(late.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
      extended,
    );
    const [attempt] = await db
      .select({
        leaseExpiresAt: attempts.leaseExpiresAt,
        lastHeartbeatAt: attempts.lastHeartbeatAt,
      })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(extended);
    expect(attempt?.lastHeartbeatAt?.getTime()).toBe(heartbeatAt);
    advance(400);
  });

  test("a checkpoint verification that outlives the lease commits nothing", async () => {
    const partition = partitionFor("slow");
    const session = await queuedSession(partition);
    const l = await launch(partition);
    const brief = briefGateway(400);
    const claimed = await brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    await brief.nextInput(principalOf(claimed), { ...scopeOf(claimed) });
    // The verifier is a network call. If it returns after the lease is gone,
    // the fence has to judge the commit by the clock at commit time.
    const slow = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
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
          await sleep(500);
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        leaseTtlMs: 400,
        now: () => clock,
        sleep: async () => {},
      },
    });
    expect(
      await failure(
        slow.finalize(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          turn_id: "1",
          finalize_key: "slow-1",
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: {
            revision: 0,
            manifest_ref: "s3://bucket/m.json",
            manifest_sha256: "a".repeat(64),
          },
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.status).toBe("running");
    const [stored] = await db
      .select({ committed: count() })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(stored?.committed).toBe(0);
  });

  test("a session whose profile this host does not know is not claimed", async () => {
    const partition = partitionFor("profile");
    const session = await queuedSession(partition);
    const l = await launch(partition);
    const stranger = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        leaseTtlMs: LEASE_TTL_MS,
        now: () => clock,
        sleep: async () => {},
      },
    });
    // Running it on a guessed runtime would be worse than waiting.
    expect(
      await failure(
        stranger.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: l.generation,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    const waiting = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(waiting).toHaveLength(1);
    // A host that knows the profile takes it.
    expect((await claim(l)).session_id).toBe(session.session_id);
  });

  test("an exit observation racing the last heartbeats never deadlocks", async () => {
    for (let round = 0; round < 5; round += 1) {
      const partition = partitionFor(`race${round}`);
      await queuedSession(partition);
      const l = await launch(partition);
      const claimed = await claim(l);
      const beats = [0, 1, 2].map(() =>
        gateway
          .heartbeat(principalOf(claimed), {
            ...scopeOf(claimed),
            attempt_state: "running",
          })
          .catch((error: unknown) => error),
      );
      const settled = await Promise.all([
        gateway.confirmExecutionGone(l.executionId),
        ...beats,
      ]);
      for (const outcome of settled) {
        // A heartbeat losing to the exit is expected; a lock-order deadlock
        // (SQLSTATE 40P01) is not.
        expect(String((outcome as { code?: string })?.code ?? "")).not.toBe(
          "40P01",
        );
      }
    }
  });

  test("a finalize that committed is still readable once the lease lapsed", async () => {
    const { claimed } = await claimAndDeliver(partitionFor("late"));
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "late-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    };
    const first = await gateway.finalize(principalOf(claimed), request);
    advance(LEASE_TTL_MS + 1);
    // The response was lost and the retry arrives too late to write. It must
    // still learn that the turn is settled: answering LEASE_EXPIRED would
    // turn a committed result into an unknown outcome.
    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(
      first,
    );
    // The same key with a different body is still a conflict.
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          terminal: {
            status: "failed" as const,
            reason: "other story",
            result: null,
            usage: null,
          },
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  test("a heartbeat keeps the session credential alive with the lease", async () => {
    const partition = partitionFor("cred");
    await queuedSession(partition);
    const l = await launch(partition);
    const uow = createPostgresWorkerUnitOfWork(db);
    const short = createWorkerGateway({
      work: uow,
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
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
        sessionCostLimitUsd: 1_000,
        leaseTtlMs: LEASE_TTL_MS,
        sessionTokenTtlMs: 600,
        now: () => clock,
        sleep: async () => {},
      },
    });
    const claimed = await short.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const token = hashWorkerToken(claimed.session_credential);
    await sleep(400);
    await short.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    await sleep(400);
    // Past the horizon the claim set, but the heartbeat pushed it out: a
    // worker that is alive does not lose its token mid-attempt.
    expect(await uow.resolveCredential(token)).toMatchObject({
      kind: "session",
      attemptId: claimed.attempt_id,
    });
    await sleep(700);
    expect(await uow.resolveCredential(token)).toBeNull();
  });

  test("a worker holding the token that lost a claim race recovers by claiming again", async () => {
    const partition = partitionFor("lostrace");
    await queuedSession(partition);
    const l = await launch(partition);
    const first = await claim(l);
    const second = await claim(l);
    // The worker received the responses out of order and kept the first
    // token, which the second claim already revoked.
    expect(
      await failure(
        gateway.nextInput(principalOf(first), { ...scopeOf(first) }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
    expect(
      await createPostgresWorkerUnitOfWork(db).resolveCredential(
        hashWorkerToken(first.session_credential),
      ),
    ).toBeNull();
    // Nothing has been done under this attempt yet, so another claim hands
    // back the same binding with a credential that works.
    const third = await claim(l);
    expect(third.attempt_id).toBe(second.attempt_id);
    expect(third.auth_revision).toBe(second.auth_revision + 1);
    const next = await gateway.nextInput(principalOf(third), {
      ...scopeOf(third),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a request that waits out its lease on the row lock is refused", async () => {
    const partition = partitionFor("lockwait");
    await queuedSession(partition);
    const l = await launch(partition);
    const brief = briefGateway(150);
    const claimed = await brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM attempts WHERE id = $1 FOR UPDATE", [
        claimed.attempt_id,
      ]);
      // The heartbeat blocks on the row lock until after its lease ends, so
      // the clock it started with must not resurrect it.
      const blocked = failure(
        brief.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      );
      await sleep(400);
      await blocker.query("COMMIT");
      expect(await blocked).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    } finally {
      blocker.release();
    }
  });

  test("a claim that waits out its TTL on the launch row still hands out a live lease", async () => {
    const partition = partitionFor("claimwait");
    await queuedSession(partition);
    const l = await launch(partition);
    const brief = briefGateway(150);
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM worker_launches WHERE execution_id = $1 FOR UPDATE",
      [l.executionId],
    );
    const pending = brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    let floor: number;
    try {
      await sleep(400);
      floor = await dbNowMs();
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    const claimed = await pending;
    // Measured from the request the 150 ms lease would have been spent on
    // the lock alone; it starts once the binding exists.
    expect(new Date(claimed.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
      floor + 150,
    );
    const next = await brief.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a claim that waits out the nonce window on the launch row is refused and binds nothing", async () => {
    const partition = partitionFor("noncewait");
    const session = await queuedSession(partition);
    const l = await launch(partition);
    // The deadline is set on the database clock so that it passes while the
    // claim is blocked on the row, not before it asks for the lock.
    await db
      .update(workerLaunches)
      .set({
        nonceExpiresAt: sql`clock_timestamp() + interval '200 milliseconds'`,
      })
      .where(eq(workerLaunches.executionId, l.executionId));
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM worker_launches WHERE execution_id = $1 FOR UPDATE",
      [l.executionId],
    );
    const pending = failure(claim(l));
    try {
      await sleep(400);
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    // Judged once the lock is granted: the window closed while waiting, so
    // the claim is refused however fresh it was when it arrived.
    expect(await pending).toEqual({ status: 401, code: "UNAUTHORIZED" });
    const [row] = await db
      .select({ claimedAttemptId: workerLaunches.claimedAttemptId })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(row?.claimedAttemptId).toBeNull();
    expect(
      await db
        .select({ n: count() })
        .from(attempts)
        .where(eq(attempts.sessionId, session.session_id)),
    ).toEqual([{ n: 0 }]);
  });

  test("a finalize that waits out its lease on the turn row commits nothing", async () => {
    const partition = partitionFor("finwait");
    const session = await queuedSession(partition);
    const l = await launch(partition);
    const brief = briefGateway(400);
    const claimed = await brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    await brief.nextInput(principalOf(claimed), { ...scopeOf(claimed) });
    const [turn] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM turns WHERE id = $1 FOR UPDATE", [
      turn?.id,
    ]);
    // The fence holds when it is taken; the lease runs out while finalize
    // waits for the turn row it is about to write.
    const blocked = failure(
      brief.finalize(principalOf(claimed), {
        ...scopeOf(claimed, "1"),
        turn_id: "1",
        finalize_key: "waited-1",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      }),
    );
    try {
      await sleep(700);
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    expect(await blocked).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [after] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(after?.status).toBe("running");
  });

  test("a nextInput that waits out its lease on the queue head delivers nothing", async () => {
    const partition = partitionFor("headwait");
    const session = await queuedSession(partition);
    const l = await launch(partition);
    const brief = briefGateway(400);
    const claimed = await brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM queue_messages WHERE session_id = $1 FOR UPDATE",
      [session.session_id],
    );
    // The fence held when it was taken. By the time the head is free the
    // lease is gone, and handing the turn over would start work on a session
    // this attempt no longer owns.
    const blocked = failure(
      brief.nextInput(principalOf(claimed), { ...scopeOf(claimed) }),
    );
    try {
      await sleep(700);
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    expect(await blocked).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [turn] = await db
      .select({ status: turns.status, attemptId: turns.attemptId })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn).toEqual({ status: "queued", attemptId: null });
  });

  test("a claim replayed on a host without the profile rotates nothing", async () => {
    const partition = partitionFor("replayprofile");
    await queuedSession(partition);
    const l = await launch(partition);
    const claimed = await claim(l);
    const stranger = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        leaseTtlMs: LEASE_TTL_MS,
        now: () => clock,
        sleep: async () => {},
      },
    });
    expect(
      await failure(
        stranger.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: l.generation,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 409, code: "BACKEND_UNAVAILABLE" });
    // The worker that holds the first token is untouched: same revision,
    // same token, and it can still take its turn.
    const [attempt] = await db
      .select({ authRevision: attempts.authRevision })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.authRevision).toBe(0);
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(claimed.session_credential)),
    ).toMatchObject({ kind: "session", attemptId: claimed.attempt_id });
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a launch reserved for one session claims that session, not the queue head", async () => {
    const partition = partitionFor("pinned");
    const first = await queuedSession(partition, "oldest");
    const second = await queuedSession(partition, "newest");
    // The backend that started this execution gave it the second session's
    // workspace; taking the older head would run one session's input in
    // another one's directory.
    const claimed = await claim(await launch(partition, second.session_id));
    expect(claimed.session_id).toBe(second.session_id);
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.message).toBe("newest");
    // The session it passed over is still waiting for its own launch.
    const waiting = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, first.session_id));
    expect(waiting).toHaveLength(1);
  });

  test("a launch reserved for a session that is already bound claims nothing", async () => {
    const partition = partitionFor("taken");
    const session = await queuedSession(partition);
    const other = await queuedSession(partition);
    await claim(await launch(partition, session.session_id));
    // Another execution for the same session must wait rather than fall
    // through to whatever else happens to be queued.
    expect(
      await failure(claim(await launch(partition, session.session_id))),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    const waiting = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, other.session_id));
    expect(waiting).toHaveLength(1);
  });

  test("two finalizes of the same turn in flight agree on one result", async () => {
    const { session, claimed } = await claimAndDeliver(partitionFor("dblfin"));
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "double-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    };
    const [a, b] = await Promise.all([
      gateway.finalize(principalOf(claimed), request),
      gateway.finalize(principalOf(claimed), request),
    ]);
    expect(a).toEqual(b);
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.status).toBe("completed");
    // The input is acknowledged once, not twice.
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, session.session_id)),
    ).toHaveLength(0);
  });

  test("a claim replayed after the lease lapsed comes back with a fresh one", async () => {
    const partition = partitionFor("lapsed");
    await queuedSession(partition);
    const l = await launch(partition);
    const brief = briefGateway(300);
    const request = {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    } as const;
    const first = await brief.bootstrapClaim(bootstrap, request);
    // The first response was lost and the retry arrives after the lease it
    // carried has run out, but before the nonce expires.
    await sleep(350);
    const floor = await dbNowMs();
    const second = await brief.bootstrapClaim(bootstrap, request);
    expect(second.attempt_id).toBe(first.attempt_id);
    expect(new Date(second.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
      floor + 300,
    );
    // The binding it just answered with actually works.
    const next = await brief.nextInput(principalOf(second), {
      ...scopeOf(second),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("the database clock judges the lease, not the clock of the replica handling the request", async () => {
    const partition = partitionFor("skew");
    await queuedSession(partition);
    const real = skewedGateway(0, 300);
    const behind = skewedGateway(-60_000, 300);
    const ahead = skewedGateway(60_000, 300);
    const executionId = `exec-${crypto.randomUUID()}`;
    const registered = await real.registerLaunch({
      executionId,
      generation: 1,
      partition,
      backend: "local_docker",
    });
    if (registered.nonce === null) throw new Error("launch already registered");
    const claimed = await behind.bootstrapClaim(bootstrap, {
      execution_id: executionId,
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: registered.nonce },
    });
    // Judged by its own clock the replica running a minute ahead would call
    // this lease long gone; the database says it is live.
    const floor = await dbNowMs();
    const beat = await ahead.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    const ceiling = await dbNowMs();
    const extended = new Date(beat.lease_expires_at).getTime();
    expect(extended).toBeGreaterThanOrEqual(floor + 300);
    expect(extended).toBeLessThanOrEqual(ceiling + 300);

    await sleep(350);
    // Judged by its own clock the replica running a minute behind would
    // still approve these writes; the database says the lease has ended.
    expect(
      await failure(
        behind.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    expect(
      await failure(
        behind.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed),
          turn_id: null,
          batch_key: "skew-1",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [attempt] = await db
      .select({ leaseExpiresAt: attempts.leaseExpiresAt })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.leaseExpiresAt.getTime()).toBe(extended);
  });

  test("the database clock judges the launch nonce, not the clock of the replica that registered or claims it", async () => {
    const partition = partitionFor("nonce-skew");
    await queuedSession(partition);
    const behind = skewedGateway(-60_000, 300);
    const ahead = skewedGateway(60_000, 300);
    const launchFrom = async (from: ReturnType<typeof skewedGateway>) => {
      const executionId = `exec-${crypto.randomUUID()}`;
      const floor = await dbNowMs();
      const registered = await from.registerLaunch({
        executionId,
        generation: 1,
        partition,
        backend: "local_docker",
      });
      const ceiling = await dbNowMs();
      if (registered.nonce === null) throw new Error("already registered");
      // The stored deadline follows the database clock plus the TTL, not the
      // registering replica's clock.
      const [row] = await db
        .select({ nonceExpiresAt: workerLaunches.nonceExpiresAt })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, executionId));
      const expiresAt = row?.nonceExpiresAt?.getTime() ?? Number.NaN;
      // The column keeps microseconds; the Date read back is floored to ms.
      expect(expiresAt).toBeGreaterThanOrEqual(
        Math.floor(floor) + DEFAULT_NONCE_TTL_MS,
      );
      expect(expiresAt).toBeLessThanOrEqual(ceiling + DEFAULT_NONCE_TTL_MS);
      return { executionId, nonce: registered.nonce, generation: 1 };
    };
    const claimWith = (
      from: ReturnType<typeof skewedGateway>,
      l: Awaited<ReturnType<typeof launchFrom>>,
    ) =>
      from.bootstrapClaim(bootstrap, {
        execution_id: l.executionId,
        execution_generation: l.generation,
        credential: { kind: "launch_nonce", nonce: l.nonce },
      });

    // Registered a minute behind, claimed a minute ahead: on either replica's
    // clock the ten-minute window is still open, and so it is in the database.
    const first = await launchFrom(behind);
    expect((await claimWith(ahead, first)).attempt_id).toMatch(/^att_/);

    // A deadline that the database has passed is refused even by the replica
    // whose own clock would still call it open.
    const second = await launchFrom(ahead);
    await db
      .update(workerLaunches)
      .set({ nonceExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workerLaunches.executionId, second.executionId));
    expect(await failure(claimWith(behind, second))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });
  test("any accepted call closes the claim replay window, not just the first input", async () => {
    const partition = partitionFor("used");
    await queuedSession(partition);
    const l = await launch(partition);
    const claimed = await claim(l);
    // An event on no turn is the worker's first sign of life. It leaves the
    // attempt with no input and no turn, and it still has to count.
    await gateway.appendEvents(principalOf(claimed), {
      ...scopeOf(claimed),
      turn_id: null,
      batch_key: "b",
      events: [event(1)],
    });
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("starting");
    // Whoever still holds the nonce cannot take the binding from under it.
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a late heartbeat cannot walk the reported phase backwards", async () => {
    const partition = partitionFor("hborder");
    await queuedSession(partition);
    const l = await launch(partition);
    const claimed = await claim(l);
    const beat = (attempt_state: "starting" | "running" | "draining") =>
      gateway.heartbeat(principalOf(claimed), {
        ...scopeOf(claimed),
        attempt_state,
      });
    const phase = async () => {
      const [row] = await db
        .select({ state: attempts.state })
        .from(attempts)
        .where(eq(attempts.id, claimed.attempt_id));
      return row?.state;
    };
    await beat("running");
    await beat("starting");
    expect(await phase()).toBe("running");
    await beat("draining");
    expect(await phase()).toBe("draining");
  });

  test("a replayed claim moves the auth revision so an older token's requests are fenced", async () => {
    const partition = partitionFor("authrev");
    await queuedSession(partition);
    const l = await launch(partition);
    const first = await claim(l);
    const second = await claim(l);
    expect(second.attempt_id).toBe(first.attempt_id);
    expect(second.auth_revision).toBe(first.auth_revision + 1);
    // A request authenticated before the rotation carries the old revision.
    expect(
      await failure(
        gateway.heartbeat(principalOf(first), {
          ...scopeOf(first),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
    // ...and it cannot address the new revision either: the token it
    // authenticated with was issued for the old one.
    expect(
      await failure(
        gateway.heartbeat(principalOf(first), {
          ...scopeOf(second),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    const beat = await gateway.heartbeat(principalOf(second), {
      ...scopeOf(second),
      attempt_state: "running",
    });
    expect(beat.auth_revision).toBe(second.auth_revision);
  });

  test("writes from a superseded epoch are refused with 409 STALE_EPOCH", async () => {
    const { session, claimed } = await claimAndDeliver();
    // A terminate/reconcile elsewhere bumps the session epoch.
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, session.session_id));
    for (const call of [
      () =>
        gateway.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      () =>
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          batch_key: "b",
          events: [event(1)],
        }),
      () =>
        gateway.finalize(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          turn_id: "1",
          finalize_key: "f",
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: null,
        }),
      () => gateway.nextInput(principalOf(claimed), scopeOf(claimed)),
    ]) {
      expect(await failure(call())).toEqual({
        status: 409,
        code: "STALE_EPOCH",
      });
    }
    expect(
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "stale",
      }),
    ).toEqual({ released: false });
    const [storedRow] = await db
      .select({ stored: count() })
      .from(events)
      .where(eq(events.sessionId, session.session_id));
    expect(storedRow?.stored).toBe(0);
  });

  test("finalize commits checkpoint, turn terminal, receipt and queue ACK in one transaction and replays by key", async () => {
    const { session, claimed } = await claimAndDeliver();
    // The first checkpoint of a session is revision 0: exactly the next one
    // after "none", as checkpointStateAtomic would have handed out.
    const checkpoint = {
      revision: 0,
      manifest_ref: "s3://bucket/manifest-0.json",
      manifest_sha256: "a".repeat(64),
    };
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: { text: "done" },
        usage: { input_tokens: 3 },
      },
      checkpoint,
    };
    const done = await gateway.finalize(principalOf(claimed), request);
    expect(done).toEqual({
      turn_id: "1",
      status: "completed",
      checkpoint_revision: 0,
    });

    const [turn] = await db
      .select()
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(turn?.status).toBe("completed");
    expect(turn?.endedAt?.toISOString()).toBe(clock.toISOString());
    expect(turn?.resultJson).toMatchObject({
      finalize_key: "fin-1",
      result: { text: "done" },
      usage: { input_tokens: 3 },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("succeeded");
    expect(receipt?.result).toEqual(session);
    const remaining = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, session.session_id));
    expect(remaining).toHaveLength(0);
    const [cp] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(cp?.revision).toBe(0);
    expect(cp?.turnId).toBe(turn?.id ?? -1);
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.status).toBe("idle");
    expect(row?.checkpointRevision).toBe(0);
    expect(row?.checkpointCommittedAt?.toISOString()).toBe(clock.toISOString());

    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(done);
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          finalize_key: "fin-2",
          final_source_sequence: 0,
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const empty = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    expect(empty.input).toBeNull();
  });

  test("a settled input replays its acceptance response for the same idempotency key (94S-265)", async () => {
    const partition = partitionFor("replay");
    const inputs = createPostgresSessionUnitOfWork(db);
    const ownerId = `owner-${crypto.randomUUID()}`;
    const create = {
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    };
    const created = await inputs.acceptInputAtomic(create);
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const sessionId = created.response.session_id;
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const claimed = await claim(await launch(partition));
    const finalizeTurn = async (
      turnId: string,
      status: "completed" | "failed",
    ) => {
      const next = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      expect(next.input?.turn_id).toBe(turnId);
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, turnId),
        turn_id: turnId,
        finalize_key: `fin-${turnId}`,
        final_source_sequence: 0,
        terminal: {
          status,
          reason: status === "failed" ? "boom" : null,
          result: { text: "done" },
          usage: null,
        },
        checkpoint: null,
      });
    };
    await finalizeTurn("1", "completed");

    const append = {
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId },
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    };
    const appended = await inputs.appendInputAtomic(append);
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    await finalizeTurn("2", "failed");

    expect(await inputs.acceptInputAtomic(create)).toEqual({
      outcome: "replayed",
      response: created.response,
    });
    expect(await inputs.appendInputAtomic(append)).toEqual({
      outcome: "replayed",
      response: appended.response,
    });
    const receiptOf = async (id: string) =>
      (
        await db
          .select({ status: receipts.status, result: receipts.result })
          .from(receipts)
          .where(eq(receipts.id, id))
      )[0];
    // Settled either way, and the current outcome is on the receipt itself.
    expect(await receiptOf(created.response.receipt_id)).toEqual({
      status: "succeeded",
      result: created.response,
    });
    expect(await receiptOf(appended.response.receipt_id)).toEqual({
      status: "failed",
      result: appended.response,
    });
  });

  test("finalize refuses a rejected manifest and a revision that is not the next one without touching the turn", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
    };
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...base,
          checkpoint: {
            revision: 0,
            manifest_ref: "bad/ref",
            manifest_sha256: "b".repeat(64),
          },
        }),
      ),
    ).toEqual({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    await db
      .update(sessions)
      .set({ checkpointRevision: 5 })
      .where(eq(sessions.id, session.session_id));
    // Neither the current revision nor one that skips ahead: only 6 is next.
    // That is a race the worker recovers from by asking again, so it is a
    // revision conflict, not an unavailable checkpoint.
    for (const revision of [5, 7]) {
      expect(
        await failure(
          gateway.finalize(principalOf(claimed), {
            ...base,
            checkpoint: {
              revision,
              manifest_ref: "ok/ref",
              manifest_sha256: "c".repeat(64),
            },
          }),
        ),
      ).toEqual({ status: 409, code: "REVISION_CONFLICT" });
    }
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(turn?.status).toBe("running");
    const [receipt] = await db
      .select({ status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("accepted");
  });

  test("the workspace descriptor rides every claim, with and without a restore pointer; a pre-catalog row is not claimed", async () => {
    const partition = partitionFor("descriptor");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    expect(claimed.restore).toBeNull();
    const checkpoint = {
      revision: 0,
      manifest_ref: "s3://bucket/descriptor-manifest-0.json",
      manifest_sha256: "b".repeat(64),
    };
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin-desc",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint,
    });
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "idle_timeout",
    });
    await gateway.confirmExecutionGone(l.executionId);
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: {
        ownerId:
          (
            await db
              .select()
              .from(sessions)
              .where(eq(sessions.id, session.session_id))
          )[0]?.ownerId ?? "",
      },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, session.session_id));
    // A pre-catalog row has no repository id, so no catalog pair can vouch
    // for it (94S-258): it waits instead of running under a profile's trust
    // that nothing granted it.
    await db
      .update(sessions)
      .set({ repositoryId: null })
      .where(eq(sessions.id, session.session_id));
    await expect(
      claim(await launch(partition, session.session_id)),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await db
      .update(sessions)
      .set({ repositoryId: "sample-app" })
      .where(eq(sessions.id, session.session_id));
    const again = await claim(await launch(partition, session.session_id));
    expect(again.session_id).toBe(session.session_id);
    expect(again.restore).toEqual(checkpoint);
    expect(again.workspace).toEqual({
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
    });
    expect(again.runtime_config.model).toBe("claude-sonnet-5");
  });

  test("claim binds only a pair the catalog allows, at the URL and branch it registers now (94S-258)", async () => {
    const profile = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default" as const,
      provider: {
        kind: "litellm" as const,
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key" as const,
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
      project_settings: { claude_md: true },
    };
    const registered = {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
    };
    const gatewayFor = (
      repositories: Record<string, typeof registered>,
    ): WorkerGateway =>
      createWorkerGateway({
        work: createPostgresWorkerUnitOfWork(db),
        catalog: {
          profiles: { "claude-coding-v1": profile, other: profile },
          repositories,
        },
        checkpoints: {
          async verify() {
            return { status: "verified" };
          },
        },
        options: {
          sessionCostLimitUsd: 1_000,
          leaseTtlMs: LEASE_TTL_MS,
          now,
          sleep: async () => {},
        },
      });
    const claimOn = (
      target: WorkerGateway,
      l: Awaited<ReturnType<typeof launch>>,
    ) =>
      target.bootstrapClaim(bootstrap, {
        execution_id: l.executionId,
        execution_generation: l.generation,
        credential: { kind: "launch_nonce", nonce: l.nonce },
      });
    const refused: Array<[string, Record<string, typeof registered>]> = [
      [
        "the repository lists another profile",
        { "sample-app": { ...registered, profiles: ["other"] } },
      ],
      [
        "the id now points at another URL",
        {
          "sample-app": {
            ...registered,
            url: "https://example.invalid/other.git",
          },
        },
      ],
      [
        "the id now points at another branch",
        { "sample-app": { ...registered, branch: "release" } },
      ],
      ["the repository left the catalog", { other: registered }],
    ];
    for (const [label, repositories] of refused) {
      const partition = partitionFor("pair");
      const session = await queuedSession(partition);
      const l = await launch(partition, session.session_id);
      await expect(
        claimOn(gatewayFor(repositories), l),
        label,
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      const [row] = await db
        .select({ podId: sessions.podId })
        .from(sessions)
        .where(eq(sessions.id, session.session_id));
      expect(row?.podId, label).toBeNull();
      // The same launch claims once the pair is allowed again.
      const claimed = await claimOn(
        gatewayFor({ "sample-app": registered }),
        l,
      );
      expect(claimed.session_id, label).toBe(session.session_id);
    }

    // A replay (the claim response was lost) on a host whose catalog no
    // longer allows the pair is refused before the token rotates.
    const partition = partitionFor("pair-replay");
    const session = await queuedSession(partition);
    const l = await launch(partition, session.session_id);
    const first = await claimOn(gatewayFor({ "sample-app": registered }), l);
    await expect(
      claimOn(
        gatewayFor({ "sample-app": { ...registered, profiles: ["other"] } }),
        l,
      ),
    ).rejects.toMatchObject({ status: 409, code: "BACKEND_UNAVAILABLE" });
    const [row] = await db
      .select({ authRevision: sessions.authRevision })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.authRevision).toBe(first.auth_revision);
  });

  test("a failed terminal marks the receipt failed and the session failed", async () => {
    const { session, claimed } = await claimAndDeliver();
    const done = await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "failed",
        reason: "sdk_error",
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    expect(done.checkpoint_revision).toBeNull();
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("failed");
    expect(receipt?.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "sdk_error",
    });
    const [row] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.status).toBe("failed");
  });

  test("release ends the attempt but the session stays unclaimable until the execution is confirmed gone", async () => {
    const partition = partitionFor("rel");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      // Covered, so the next claim restores it rather than meeting the
      // context gate (94S-288).
      checkpoint: {
        revision: 0,
        manifest_ref: "s3://bucket/release-0.json",
        manifest_sha256: "a".repeat(64),
      },
    });
    // A second input arrives while the worker is still bound.
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: {
        ownerId:
          (
            await db
              .select()
              .from(sessions)
              .where(eq(sessions.id, session.session_id))
          )[0]?.ownerId ?? "",
      },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    expect(
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "idle_timeout",
      }),
    ).toEqual({ released: true });
    expect(
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "idle_timeout",
      }),
    ).toEqual({ released: false });
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("exited");
    expect(attempt?.endReason).toBe("idle_timeout");
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(claimed.session_credential)),
    ).toBeNull();

    // No new claim while the execution may still be alive.
    const next = await launch(partition);
    expect(await failure(claim(next))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    const [bound] = await db
      .select({ podId: sessions.podId, leaseEpoch: sessions.leaseEpoch })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(bound?.podId).toBe(l.executionId);
    expect(bound?.leaseEpoch).toBe(claimed.lease_epoch + 1);

    expect(await gateway.confirmExecutionGone(l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const reclaimed = await claim(next);
    expect(reclaimed.session_id).toBe(session.session_id);
    expect(reclaimed.lease_epoch).toBe(claimed.lease_epoch + 3);
    expect(reclaimed.restore?.revision).toBe(0);
    const redelivered = await gateway.nextInput(
      principalOf(reclaimed),
      scopeOf(reclaimed),
    );
    expect(redelivered.input?.turn_id).toBe("2");
    expect(redelivered.input?.message).toBe("second input");
  });

  test("an execution that ends mid-turn leaves an unknown outcome, not work in progress", async () => {
    const partition = partitionFor("unk");
    const { session, launch: l } = await claimAndDeliver(partition);
    expect(await gateway.confirmExecutionGone(l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    // Nothing re-signals the session: the delivered input must not run again.
    const signals = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(signals).toHaveLength(0);
    const [row] = await db
      .select({
        podId: sessions.podId,
        status: sessions.status,
        admissionState: sessions.admissionState,
      })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row).toEqual({
      podId: null,
      status: "failed",
      admissionState: "recovery_required",
    });
    const [turn] = await db
      .select({
        status: turns.status,
        outcomeUnknown: turns.outcomeUnknown,
        terminalReason: turns.terminalReason,
      })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn).toEqual({
      status: "outcome_unknown",
      outcomeUnknown: true,
      terminalReason: "execution_gone",
    });
    const [receipt] = await db
      .select({ status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("unknown");
    // The input stays on the queue for the operator decision (94S-140).
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, session.session_id)),
    ).toHaveLength(1);
  });

  test("a heartbeat cannot walk the attempt back to allocated or end it", async () => {
    const partition = partitionFor("hbstate");
    await queuedSession(partition);
    const l = await launch(partition);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    for (const state of ["allocated", "exited", "lost"] as const) {
      expect(
        await failure(
          gateway.heartbeat(principalOf(claimed), {
            ...scopeOf(claimed),
            attempt_state: state,
          }),
        ),
      ).toEqual({ status: 400, code: "BAD_REQUEST" });
    }
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("running");
    // The claim-replay door stays shut, which a regression would reopen.
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  test("launch slots: bootstrapClaim inherits the reservation and each exit returns it exactly once", async () => {
    const partition = partitionFor("slots");
    const work = createPostgresWorkerUnitOfWork(db);
    const launches = [];
    for (let i = 0; i < 30; i += 1) {
      await queuedSession(partition);
      launches.push(await launch(partition));
    }
    expect(await work.countReservedSlots(partition)).toBe(30);
    for (const l of launches) {
      const claimed = await claim(l);
      await claim(l);
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "done",
      });
    }
    expect(await work.countReservedSlots(partition)).toBe(30);
    for (const l of launches) {
      expect(
        (await gateway.confirmExecutionGone(l.executionId)).slotReleased,
      ).toBe(true);
      expect(
        (await gateway.confirmExecutionGone(l.executionId)).slotReleased,
      ).toBe(false);
    }
    expect(await work.countReservedSlots(partition)).toBe(0);
  });

  // 94S-309: every worker with a mirror beats this way until its first batch
  // lands, and the empty update it used to run failed the beat with a 500.
  test("a transcript report with nothing mirrored yet extends the lease and records nothing", async () => {
    const partition = partitionFor("mirrorempty");
    const { session, claimed } = await claimAndDeliver(partition);
    const read = async () =>
      (
        await db
          .select({
            lease: attempts.leaseExpiresAt,
            pending: sessions.checkpointPendingReason,
            persistedAt: sessions.lastTranscriptPersistedAt,
          })
          .from(sessions)
          .innerJoin(attempts, eq(attempts.id, claimed.attempt_id))
          .where(eq(sessions.id, session.session_id))
      )[0];
    const before = await read();
    await Bun.sleep(5);
    const beat = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: { persisted_at: null, mirror_error: null },
    });
    const after = await read();
    expect(new Date(beat.lease_expires_at).getTime()).toBeGreaterThan(
      before?.lease.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(after).toEqual({
      lease: new Date(beat.lease_expires_at),
      pending: null,
      persistedAt: null,
    });
  });

  test("a mirror failure holds new input and completed terminals, and a checkpoint from the same attempt does not release it", async () => {
    const partition = partitionFor("mirror");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    const ownerId =
      (
        await db
          .select({ ownerId: sessions.ownerId })
          .from(sessions)
          .where(eq(sessions.id, session.session_id))
      )[0]?.ownerId ?? "";
    const append = (message: string) =>
      createPostgresSessionUnitOfWork(db).appendInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message,
      });
    const row = async () => {
      const [stored] = await db
        .select({
          pending: sessions.checkpointPendingReason,
          pendingAttempt: sessions.checkpointPendingAttemptId,
          persistedAt: sessions.lastTranscriptPersistedAt,
          revision: sessions.checkpointRevision,
        })
        .from(sessions)
        .where(eq(sessions.id, session.session_id));
      return stored;
    };
    // Queued before the failure: what the next attempt will run.
    expect((await append("second input")).outcome).toBe("accepted");

    const later = new Date("2026-09-22T00:00:10.000Z");
    const earlier = new Date("2026-09-22T00:00:05.000Z");
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: {
        persisted_at: later.toISOString(),
        mirror_error: "batch 7 dropped",
      },
    });
    expect(await row()).toMatchObject({
      pending: "mirror_error",
      pendingAttempt: claimed.attempt_id,
      persistedAt: later,
    });
    // A late heartbeat neither walks the mark back nor clears the reason.
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: { persisted_at: earlier.toISOString(), mirror_error: null },
    });
    expect(await row()).toMatchObject({
      pending: "mirror_error",
      persistedAt: later,
    });
    // Neither does asking for a checkpoint at a safe boundary.
    expect(
      await createPostgresWorkerUnitOfWork(db).checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
      }),
    ).toEqual({
      outcome: "ok",
      pointer: null,
      restorable: false,
      pendingReason: "mirror_error",
    });

    // New input is refused: a turn run now could never be reported done.
    expect(await append("third input")).toEqual({
      outcome: "checkpoint_unavailable",
      reason: "mirror_error",
    });
    // So is a success the worker cannot back with a checkpoint...
    const terminal = (status: "completed" | "interrupted") => ({
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: `fin-${status}`,
      final_source_sequence: 0,
      terminal: { status, reason: null, result: null, usage: null },
    });
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...terminal("completed"),
          checkpoint: null,
        }),
      ),
    ).toEqual({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    const [open] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(open?.status).toBe("running");
    // ...while a checkpoint from the same attempt closes the turn but proves
    // nothing about the transcript since the failure: the reason stays.
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...terminal("completed"),
        checkpoint: {
          revision: 0,
          manifest_ref: "s3://bucket/mirror-0.json",
          manifest_sha256: "a".repeat(64),
        },
      }),
    ).toMatchObject({ status: "completed", checkpoint_revision: 0 });
    expect(await row()).toMatchObject({ pending: "mirror_error", revision: 0 });

    // The pointer the failing run committed is not trusted, so no worker
    // can take the session on from it: once the execution is gone the
    // session waits on an operator instead of being restored from a
    // transcript that may be missing entries (94S-288).
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "mirror_error",
    });
    await gateway.confirmExecutionGone(l.executionId);
    const [held] = await db
      .select({
        admission: sessions.admissionState,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(held).toEqual({ admission: "recovery_required", status: "failed" });
    expect(
      (
        await db
          .select({ id: unassignedSessions.sessionId })
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.session_id))
      ).length,
    ).toBe(0);
    expect(await row()).toMatchObject({ pending: "mirror_error", revision: 0 });
  });

  test("a mirror failure never holds back an interrupt that commits its checkpoint", async () => {
    const { session, claimed } = await claimAndDeliver();
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: { persisted_at: null, mirror_error: "batch 2 dropped" },
    });
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, "1"),
        turn_id: "1",
        finalize_key: "fin-int",
        final_source_sequence: 0,
        terminal: {
          status: "interrupted",
          reason: "user",
          result: null,
          usage: null,
        },
        // 94S-128: an interrupt is only ever recorded with its checkpoint.
        checkpoint: {
          revision: 0,
          manifest_ref: "manifests/interrupted.json",
          manifest_sha256: "d".repeat(64),
        },
      }),
    ).toMatchObject({ status: "interrupted", checkpoint_revision: 0 });
    const [stored] = await db
      .select({
        status: sessions.status,
        pending: sessions.checkpointPendingReason,
      })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(stored).toEqual({ status: "stopped", pending: "mirror_error" });
  });

  test("a run that was not quiescent is recorded for display, holds nothing back, and yields to a mirror failure", async () => {
    const partition = partitionFor("quiesce");
    const { session, claimed } = await claimAndDeliver(partition);
    const work = createPostgresWorkerUnitOfWork(db);
    const ownerId =
      (
        await db
          .select({ ownerId: sessions.ownerId })
          .from(sessions)
          .where(eq(sessions.id, session.session_id))
      )[0]?.ownerId ?? "";
    const append = (message: string) =>
      createPostgresSessionUnitOfWork(db).appendInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message,
      });
    const pending = async () =>
      (
        await db
          .select({ reason: sessions.checkpointPendingReason })
          .from(sessions)
          .where(eq(sessions.id, session.session_id))
      )[0]?.reason;
    const finalize = (turnId: string, revision: number | null) =>
      gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, turnId),
        turn_id: turnId,
        finalize_key: `fin-${turnId}`,
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint:
          revision === null
            ? null
            : {
                revision,
                manifest_ref: `s3://bucket/quiesce-${revision}.json`,
                manifest_sha256: "c".repeat(64),
              },
      });

    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
        pendingReason: "background_writer",
      }),
    ).toEqual({
      outcome: "ok",
      pointer: null,
      restorable: false,
      pendingReason: "background_writer",
    });
    expect(await pending()).toBe("background_writer");
    // The previous generation stays the one to resume from, and work goes on:
    // new input is taken and the turn completes without a checkpoint.
    expect((await append("while the server runs")).outcome).toBe("accepted");
    expect(await finalize("1", null)).toMatchObject({
      status: "completed",
      checkpoint_revision: null,
    });
    expect(await pending()).toBe("background_writer");

    // This attempt's own next checkpoint is exactly what was missing.
    const next = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    expect(next.input?.turn_id).toBe("2");
    expect(await finalize("2", 0)).toMatchObject({
      status: "completed",
      checkpoint_revision: 0,
    });
    expect(await pending()).toBeNull();

    // A mirror failure outranks it, and is not replaced by it.
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: { persisted_at: null, mirror_error: "batch 3 dropped" },
    });
    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
        pendingReason: "tool_in_flight",
      }),
    ).toMatchObject({ pendingReason: "mirror_error" });
    expect(await pending()).toBe("mirror_error");
    expect(await append("after the failure")).toEqual({
      outcome: "checkpoint_unavailable",
      reason: "mirror_error",
    });
  });

  test("checkpointStateAtomic answers the fenced pointer and records only a durable refusal", async () => {
    const { session, claimed } = await claimAndDeliver();
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
      }),
    ).toEqual({
      outcome: "ok",
      pointer: null,
      restorable: false,
      pendingReason: null,
    });
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 0,
        manifest_ref: "s3://bucket/state-0.json",
        manifest_sha256: "a".repeat(64),
      },
    });
    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
        pendingReason: "mirror_error",
      }),
    ).toEqual({
      outcome: "ok",
      pointer: {
        committedAt: clock,
        manifestRef: "s3://bucket/state-0.json",
        manifestSha256: "a".repeat(64),
        manifestVersion: null,
        parentRevision: null,
        revision: 0,
        turnId: "1",
        versionsHeld: false,
      },
      // The blocker just recorded makes the pointer untrusted at once.
      restorable: false,
      pendingReason: "mirror_error",
    });
    // The store reads the same pointer, outside any fence.
    expect(
      await createPostgresCheckpointStore(db).readPointer(session.session_id),
    ).toMatchObject({ revision: 0, turnId: "1" });
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, session.session_id));
    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
      }),
    ).toEqual({ outcome: "stale_epoch" });
    // A pointer at a revision no row describes is corruption, not "none".
    await db
      .update(sessions)
      .set({ checkpointRevision: 9 })
      .where(eq(sessions.id, session.session_id));
    await expect(
      createPostgresCheckpointStore(db).readPointer(session.session_id),
    ).rejects.toThrow(/revision 9/);
  });

  test("the store's turn-less commit judges the fence and the next revision like a finalize does", async () => {
    const { session, claimed } = await claimAndDeliver();
    const store = createPostgresCheckpointStore(db);
    const commit = (revision: number, sha: string) =>
      store.commitAtomic({
        checkpoint: {
          revision,
          manifest_ref: `s3://bucket/turnless-${revision}.json`,
          manifest_sha256: sha.repeat(64),
        },
        fence: fenceOf(claimed),
        now: clock,
        sessionId: session.session_id,
        turnId: null,
      });
    expect(await commit(1, "a")).toEqual({
      outcome: "conflict",
      currentRevision: null,
    });
    // A turn's checkpoint belongs to its finalize; this path will not attach
    // one, not even the session's own delivered turn.
    await expect(
      store.commitAtomic({
        checkpoint: {
          revision: 0,
          manifest_ref: "s3://bucket/turnless-0.json",
          manifest_sha256: "a".repeat(64),
        },
        fence: fenceOf(claimed),
        now: clock,
        sessionId: session.session_id,
        turnId: "1",
      }),
    ).rejects.toThrow(/turn-less checkpoints only/);
    expect(await commit(0, "a")).toEqual({ outcome: "committed", revision: 0 });
    expect(await commit(0, "a")).toEqual({ outcome: "replayed", revision: 0 });
    expect(await commit(0, "b")).toEqual({
      outcome: "conflict",
      currentRevision: 0,
    });
    expect(await store.readPointer(session.session_id)).toMatchObject({
      revision: 0,
      turnId: null,
    });
    // The turn's own finalize continues from the pointer the store moved.
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, "1"),
        turn_id: "1",
        finalize_key: "fin",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 1,
          manifest_ref: "s3://bucket/turnless-1.json",
          manifest_sha256: "c".repeat(64),
        },
      }),
    ).toMatchObject({ checkpoint_revision: 1 });
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, session.session_id));
    expect(await commit(2, "d")).toEqual({ outcome: "stale_epoch" });
  });

  test("the pointer keeps the manifest version it was committed with, and a replay must name the same one (94S-229)", async () => {
    const { session, claimed } = await claimAndDeliver();
    const store = createPostgresCheckpointStore(db);
    const commit = (revision: number, version?: string, versionsHeld = true) =>
      store.commitAtomic({
        checkpoint: {
          revision,
          manifest_ref: `s3://bucket/versioned-${revision}.json`,
          manifest_sha256: "a".repeat(64),
          ...(version === undefined ? {} : { manifest_version: version }),
        },
        fence: fenceOf(claimed),
        now: clock,
        sessionId: session.session_id,
        turnId: null,
        versionsHeld,
      });
    expect(await commit(0, "v1")).toEqual({
      outcome: "committed",
      revision: 0,
    });
    expect(await store.readPointer(session.session_id)).toMatchObject({
      manifestVersion: "v1",
      revision: 0,
      versionsHeld: true,
    });
    expect(await commit(0, "v1")).toEqual({ outcome: "replayed", revision: 0 });
    // A replay answers from the row; it never rewrites what was recorded.
    expect(await commit(0, "v1", false)).toEqual({
      outcome: "replayed",
      revision: 0,
    });
    expect(await store.readPointer(session.session_id)).toMatchObject({
      versionsHeld: true,
    });
    // The same bytes stored again are another object: the one this pointer
    // names is the one that was verified and held.
    expect(await commit(0, "v2")).toEqual({
      outcome: "conflict",
      currentRevision: 0,
    });
    expect(await commit(0)).toEqual({
      outcome: "conflict",
      currentRevision: 0,
    });
    const [row] = await db
      .select({ version: checkpoints.manifestVersion })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(row?.version).toBe("v1");
  });

  test("listCheckpoints returns the revisions below the one asked, newest first, bounded (94S-204)", async () => {
    const { session, claimed } = await claimAndDeliver();
    const store = createPostgresCheckpointStore(db);
    for (const revision of [0, 1, 2, 3]) {
      expect(
        await store.commitAtomic({
          checkpoint: {
            revision,
            manifest_ref: `s3://bucket/listed-${revision}.json`,
            manifest_sha256: String(revision).repeat(64),
            ...(revision === 1 ? {} : { manifest_version: `v${revision}` }),
          },
          fence: fenceOf(claimed),
          now: clock,
          sessionId: session.session_id,
          turnId: null,
          versionsHeld: revision !== 2,
        }),
      ).toEqual({ outcome: "committed", revision });
    }
    const listed = await store.listCheckpoints(session.session_id, {
      belowRevision: 3,
      limit: 2,
    });
    expect(listed).toEqual([
      {
        committedAt: expect.any(Date),
        manifestRef: "s3://bucket/listed-2.json",
        manifestSha256: "2".repeat(64),
        manifestVersion: "v2",
        parentRevision: 1,
        revision: 2,
        turnId: null,
        versionsHeld: false,
      },
      {
        committedAt: expect.any(Date),
        manifestRef: "s3://bucket/listed-1.json",
        manifestSha256: "1".repeat(64),
        manifestVersion: null,
        parentRevision: 0,
        revision: 1,
        turnId: null,
        versionsHeld: true,
      },
    ]);
    expect(
      (
        await store.listCheckpoints(session.session_id, {
          belowRevision: 10,
          limit: 10,
        })
      ).map((row) => row.revision),
    ).toEqual([3, 2, 1, 0]);
    expect(
      await store.listCheckpoints(session.session_id, {
        belowRevision: 0,
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      await store.listCheckpoints(session.session_id, {
        belowRevision: 3,
        limit: 0,
      }),
    ).toEqual([]);
    // Another session's rows never leak into this one's list.
    expect(
      await store.listCheckpoints(crypto.randomUUID(), {
        belowRevision: 10,
        limit: 10,
      }),
    ).toEqual([]);
  });

  test("a restore that falls back is recorded on the session and its event stream, and the next commit clears it (94S-204)", async () => {
    const { session, claimed } = await claimAndDeliver();
    const sessionId = session.session_id;
    const fence = fenceOf(claimed);
    const store = createPostgresCheckpointStore(db);
    const work = createPostgresWorkerUnitOfWork(db);
    // Revision 0 was taken before any turn; revision 1 closes turn 1.
    expect(
      await store.commitAtomic({
        checkpoint: {
          revision: 0,
          manifest_ref: "s3://bucket/fallback-0.json",
          manifest_sha256: "a".repeat(64),
        },
        fence,
        now: clock,
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, "1"),
        turn_id: "1",
        finalize_key: "fin",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 1,
          manifest_ref: "s3://bucket/fallback-1.json",
          manifest_sha256: "b".repeat(64),
        },
      }),
    ).toMatchObject({ checkpoint_revision: 1 });

    const row = async () => {
      const [found] = await db
        .select({
          revision: sessions.checkpointFallbackRevision,
          attempt: sessions.checkpointRestoreAttemptId,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return found;
    };
    const blocker = () =>
      db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        if (!found) throw new Error("session vanished");
        return pauseBlocker(tx, found);
      });
    const announced = () =>
      db
        .select({ payload: events.payload, attemptId: events.attemptId })
        .from(events)
        .where(
          and(
            eq(events.sessionId, sessionId),
            sql`${events.payload}->>'subtype' = ${CHECKPOINT_RESTORE_FALLBACK}`,
          ),
        );
    const skipped = [{ revision: 1, reason: "manifest object is missing" }];
    const record = (
      pointerRevision: number,
      fallback: { revision: number; skipped: typeof skipped } | null,
    ) =>
      work.recordRestoreBaseAtomic({
        fence,
        now: clock,
        pointerRevision,
        fallback,
      });

    expect(await blocker()).toBeNull();
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "ok",
    });
    expect(await row()).toEqual({ revision: 0, attempt: claimed.attempt_id });
    // A retry is the same announcement, not a second one; a different base
    // for the same pointer is refused; a stale pointer is a conflict.
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "ok",
    });
    expect(await record(1, { revision: 5, skipped })).toEqual({
      outcome: "base_changed",
      recordedRevision: 0,
    });
    expect(await record(0, { revision: 0, skipped })).toEqual({
      outcome: "pointer_moved",
      currentRevision: 1,
    });
    expect(await announced()).toEqual([
      {
        attemptId: null,
        payload: {
          type: "system",
          subtype: CHECKPOINT_RESTORE_FALLBACK,
          attempt_id: claimed.attempt_id,
          pointer_revision: 1,
          restored_revision: 0,
          skipped,
        },
      },
    ]);
    // Turn 1 ran, and the revision the session now runs on does not cover
    // it: a pause may no longer lean on the damaged pointer.
    expect(await blocker()).toBe("checkpoint_unavailable");

    // The same attempt handed the pointer after all is refused too: the
    // object may have come back between two requests, and the worker could
    // restore either plan.
    expect(await record(1, null)).toEqual({
      outcome: "base_changed",
      recordedRevision: 0,
    });

    // Another attempt restoring the pointer puts the session back on it.
    // The row, not a second claim, stands in for that attempt having been
    // the one served before.
    const handedTo = async (attempt: string) => {
      await db
        .update(sessions)
        .set({ checkpointRestoreAttemptId: attempt })
        .where(eq(sessions.id, sessionId));
    };
    await handedTo("att_earlier");
    expect(await record(1, null)).toEqual({ outcome: "ok" });
    expect(await row()).toEqual({
      revision: null,
      attempt: claimed.attempt_id,
    });
    expect(await blocker()).toBeNull();
    // Having been served the pointer, this attempt cannot be handed an
    // earlier revision for it either.
    expect(await record(1, null)).toEqual({ outcome: "ok" });
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "base_changed",
      recordedRevision: 1,
    });

    // The next committed checkpoint clears a fallback as well.
    await handedTo("att_earlier");
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "ok",
    });
    expect(await announced()).toHaveLength(2);
    expect(
      await store.commitAtomic({
        checkpoint: {
          revision: 2,
          manifest_ref: "s3://bucket/fallback-2.json",
          manifest_sha256: "c".repeat(64),
        },
        fence,
        now: clock,
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 2 });
    expect(await row()).toEqual({ revision: null, attempt: null });
    // The commit was built on what the restore handed out, not on the pointer
    // it skipped, and a later fallback walks back along that.
    expect(await store.readPointer(sessionId)).toMatchObject({
      revision: 2,
      parentRevision: 0,
    });
    expect(
      (
        await store.listCheckpoints(sessionId, { belowRevision: 2, limit: 1 })
      )[0],
    ).toMatchObject({ revision: 1, parentRevision: 0 });

    // A fallback another attempt was handed is not what this one runs on:
    // its commit builds on the pointer.
    await db
      .update(sessions)
      .set({
        checkpointFallbackRevision: 0,
        checkpointRestoreAttemptId: "att_earlier",
      })
      .where(eq(sessions.id, sessionId));
    expect(
      await store.commitAtomic({
        checkpoint: {
          revision: 3,
          manifest_ref: "s3://bucket/fallback-3.json",
          manifest_sha256: "d".repeat(64),
        },
        fence,
        now: clock,
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 3 });
    expect(await store.readPointer(sessionId)).toMatchObject({
      revision: 3,
      parentRevision: 2,
    });

    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, sessionId));
    expect(await record(3, { revision: 0, skipped })).toEqual({
      outcome: "stale_epoch",
    });
    expect(await announced()).toHaveLength(2);
  });
});
