import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerEvent, WorkerScope } from "@agent-platform/contracts";
import {
  createWorkerGateway,
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
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

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
          },
        },
        repositories: {},
      },
      checkpoints: {
        async verify({ checkpoint }) {
          return checkpoint.manifest_ref.startsWith("bad/")
            ? { status: "rejected", reason: "hash mismatch" }
            : { status: "verified" };
        },
      },
      options: { leaseTtlMs: LEASE_TTL_MS, now, sleep: async () => {} },
    });
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function launch(partition: string) {
    const executionId = `exec-${crypto.randomUUID()}`;
    const registered = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      backend: "local_docker",
    });
    if (registered.nonce === null) throw new Error("launch already registered");
    return { executionId, nonce: registered.nonce, generation: 1 };
  }

  // Every test owns a partition so leftovers from other tests never compete.
  async function queuedSession(partition: string, message = "first input") {
    const result = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
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
      await work.resolveCredential(
        hashWorkerToken(first.session_credential),
        clock,
      ),
    ).toBeNull();
    expect(
      await work.resolveCredential(
        hashWorkerToken(retry.session_credential),
        clock,
      ),
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
      .set({ nonceExpiresAt: new Date(clock.getTime() - 1) })
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
          work.resolveCredential(hashWorkerToken(c.session_credential), clock),
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
    const { claimed } = await claimAndDeliver();
    const before = new Date(claimed.lease_expires_at).getTime();
    advance(1_000);
    const beat = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    expect(new Date(beat.lease_expires_at).getTime()).toBe(
      clock.getTime() + LEASE_TTL_MS,
    );
    expect(new Date(beat.lease_expires_at).getTime()).toBeGreaterThan(before);
    expect(beat.auth_revision).toBe(0);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.lastHeartbeatAt?.toISOString()).toBe(clock.toISOString());
    expect(attempt?.state).toBe("running");

    advance(LEASE_TTL_MS + 1);
    expect(
      await failure(
        gateway.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          batch_key: "b1",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    // Giving the binding up is still allowed on the current epoch.
    expect(
      await gateway.release(principalOf(claimed), {
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
      .set({ nonceExpiresAt: new Date(clock.getTime() - 1) })
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    // The running worker keeps the token it already holds.
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(
        hashWorkerToken(first.session_credential),
        clock,
      ),
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
      terminal: {
        status: "interrupted",
        reason: "user_stop",
        result: null,
        usage: null,
      },
      checkpoint: null,
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
      leaseTtlMs: 1_000,
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
      leaseTtlMs: 1_000,
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
      await work.resolveCredential(
        hashWorkerToken(first.session_credential),
        clock,
      ),
    ).not.toBeNull();
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
    // attempt instead of being delivered and then abandoned.
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input).toBeNull();
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
    // An overlapping heartbeat carrying an older server timestamp lands
    // second; it must not undo the extension the first one committed.
    advance(-400);
    const late = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    expect(new Date(late.lease_expires_at).getTime()).toBe(extended);
    const [attempt] = await db
      .select({
        leaseExpiresAt: attempts.leaseExpiresAt,
        lastHeartbeatAt: attempts.lastHeartbeatAt,
      })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.leaseExpiresAt.getTime()).toBe(extended);
    expect(attempt?.lastHeartbeatAt?.getTime()).toBe(extended - LEASE_TTL_MS);
    advance(400);
  });

  test("a checkpoint verification that outlives the lease commits nothing", async () => {
    const { session, claimed } = await claimAndDeliver(partitionFor("slow"));
    // The verifier is a network call. If it returns after the lease is gone,
    // the fence has to judge the commit by the clock at commit time.
    const slow = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
          },
        },
        repositories: {},
      },
      checkpoints: {
        async verify() {
          advance(LEASE_TTL_MS + 1);
          return { status: "verified" };
        },
      },
      options: {
        leaseTtlMs: LEASE_TTL_MS,
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
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: {
            revision: 1,
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
          },
        },
        repositories: {},
      },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        leaseTtlMs: LEASE_TTL_MS,
        sessionTokenTtlMs: 1_000,
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
    advance(600);
    await short.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    advance(600);
    // Past the horizon the claim set, but the heartbeat pushed it out: a
    // worker that is alive does not lose its token mid-attempt.
    expect(await uow.resolveCredential(token, clock)).toMatchObject({
      kind: "session",
      attemptId: claimed.attempt_id,
    });
    advance(1_500);
    expect(await uow.resolveCredential(token, clock)).toBeNull();
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
        clock,
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
    const brief = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
          },
        },
        repositories: {},
      },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: { leaseTtlMs: 150, now: () => clock, sleep: async () => {} },
    });
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
      await new Promise((resolve) => setTimeout(resolve, 400));
      await blocker.query("COMMIT");
      expect(await blocked).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    } finally {
      blocker.release();
    }
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
    const checkpoint = {
      revision: 1,
      manifest_ref: "s3://bucket/manifest-1.json",
      manifest_sha256: "a".repeat(64),
    };
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin-1",
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
      checkpoint_revision: 1,
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
    expect(receipt?.result).toEqual({ turn_id: "1", status: "completed" });
    const remaining = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, session.session_id));
    expect(remaining).toHaveLength(0);
    const [cp] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(cp?.revision).toBe(1);
    expect(cp?.turnId).toBe(turn?.id ?? -1);
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.status).toBe("idle");
    expect(row?.checkpointRevision).toBe(1);
    expect(row?.checkpointCommittedAt?.toISOString()).toBe(clock.toISOString());

    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(done);
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          finalize_key: "fin-2",
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const empty = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    expect(empty.input).toBeNull();
  });

  test("finalize refuses a rejected manifest and a non-monotonic revision without touching the turn", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
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
            revision: 1,
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
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...base,
          checkpoint: {
            revision: 5,
            manifest_ref: "ok/ref",
            manifest_sha256: "c".repeat(64),
          },
        }),
      ),
    ).toEqual({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
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

  test("a failed terminal marks the receipt failed and the session failed", async () => {
    const { session, claimed } = await claimAndDeliver();
    const done = await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
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
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    // A second input arrives while the worker is still bound.
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
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
      await work.resolveCredential(
        hashWorkerToken(claimed.session_credential),
        clock,
      ),
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
});
