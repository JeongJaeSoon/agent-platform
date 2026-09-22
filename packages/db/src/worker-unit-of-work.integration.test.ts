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
    expect(turn?.resultJson).toEqual({
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

  test("an unfinalized delivered turn keeps the session out of the claim pool after the execution is gone", async () => {
    const partition = partitionFor("unk");
    const { session, launch: l } = await claimAndDeliver(partition);
    expect(await gateway.confirmExecutionGone(l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const signals = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(signals).toHaveLength(0);
    const [row] = await db
      .select({ podId: sessions.podId })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.podId).toBeNull();
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
