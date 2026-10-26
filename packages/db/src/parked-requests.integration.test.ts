import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  PendingSettlement,
  PostSessionAnswerRequest,
  RegisterPendingRequest,
  WorkerScope,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createPendingRequestService,
  createWorkerGateway,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { revokeExecutionAtomic } from "./execution-revocation.ts";
import { createPostgresTurnInterrupts } from "./interrupt-control.ts";
import { pauseBlocker } from "./pause-control.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  checkpoints,
  events,
  pendingRequests,
  permissionGrants,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { announceLapsedInputWaits } from "./session-events.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const catalog: SessionCatalog = {
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
};

function permission(command = "ls"): RegisterPendingRequest["request"] {
  return { kind: "permission", tool: "Bash", input: { command } };
}

// A park as the worker will commit it (94S-858): the turn ends interrupted
// with its open requests marked parked, the worker releases, the execution
// goes, and the session settles paused for input. Written here row by row,
// since no worker parks yet.
integration("parked pending requests on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let service: ReturnType<typeof createPendingRequestService>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "parked_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      pending: createPostgresWorkerPendingStore(db),
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 60_000,
        sleep: async () => {},
      },
    });
    service = createPendingRequestService({
      authorization: createAuthorizationPolicy(),
      store: createPostgresPendingRequests(db),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const controls = () => createPostgresSessionControl(db);
  const reader = () => createPostgresSessionReader(db);

  type Worker = {
    principal: WorkerPrincipal;
    scope: WorkerScope & { turn_id: string };
    executionId: string;
  };

  async function runningSession() {
    const partition = `parked-${crypto.randomUUID()}`;
    const owner = testCaller(`owner-${crypto.randomUUID()}`);
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const executionId = `exec-${crypto.randomUUID()}`;
    const registered = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      backend: "local_docker",
    });
    if (registered.nonce === null) throw new Error("launch already registered");
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: executionId,
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: registered.nonce },
    });
    const principal: WorkerPrincipal = {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
    const scope: WorkerScope = {
      session_id: claimed.session_id,
      turn_id: null,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    };
    const next = await gateway.nextInput(principal, scope);
    if (!next.input) throw new Error("no input delivered");
    const worker: Worker = {
      principal,
      scope: { ...scope, turn_id: next.input.turn_id },
      executionId,
    };
    return { owner, sessionId, worker };
  }

  async function register(worker: Worker, inputHash = HASH_A) {
    const requestId = `req_${crypto.randomUUID()}`;
    await gateway.registerPending(worker.principal, {
      ...worker.scope,
      request_id: requestId,
      input_hash: inputHash,
      request: permission(),
    });
    return requestId;
  }

  function answer(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
    requestId: string,
  ) {
    const body: PostSessionAnswerRequest = {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    };
    return service.answer(owner, sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body,
    });
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof SessionServiceError) return error.code;
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  function poll(worker: Worker, settled: PendingSettlement[] = []) {
    return gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: 0,
      settled,
    });
  }

  function executionGone(worker: Worker) {
    return createPostgresWorkerUnitOfWork(db).confirmExecutionGoneAtomic({
      executionId: worker.executionId,
      now: new Date(),
    });
  }

  async function request(requestId: string) {
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    if (!row) throw new Error(`no request ${requestId}`);
    return row;
  }

  async function receipt(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  async function sessionRow(sessionId: string) {
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) throw new Error(`no session ${sessionId}`);
    return row;
  }

  // The finalize half of a park: turn 1 interrupted, the given requests
  // parked. The execution is left for the caller to end.
  async function parkRows(worker: Worker, requestIds: string[]) {
    const [turn] = await db
      .update(turns)
      .set({
        status: "interrupted",
        endedAt: sql`now()`,
        terminalReason: "input_wait_parked",
      })
      .where(
        and(
          eq(turns.sessionId, worker.scope.session_id),
          eq(turns.sequence, 1),
        ),
      )
      .returning({ id: turns.id });
    for (const requestId of requestIds) {
      await db
        .update(pendingRequests)
        .set({ parkedAt: sql`now()` })
        .where(eq(pendingRequests.requestId, requestId));
    }
    if (!turn) throw new Error("no turn 1");
    return turn.id;
  }

  // The whole park, ending paused as confirmExecutionGone will leave it.
  async function parked() {
    const running = await runningSession();
    const requestId = await register(running.worker);
    const turnRowId = await parkRows(running.worker, [requestId]);
    await executionGone(running.worker);
    await db
      .update(sessions)
      .set({
        admissionState: "paused",
        status: "idle",
        pauseReason: "awaiting_input",
      })
      .where(eq(sessions.id, running.sessionId));
    return { ...running, requestId, turnRowId };
  }

  async function reads(
    owner: ReturnType<typeof testCaller>,
    sessionId: string,
  ) {
    const viewer = { userId: null, apiKeyId: null };
    const detail = await reader().getSession(owner.ownerId, sessionId);
    const filtered = async (status: "needs_input" | "idle") =>
      (
        await reader().listSessions(
          owner.ownerId,
          { limit: 10, status },
          viewer,
        )
      ).items.length;
    const counted = await reader().countSessions(owner.ownerId, {}, viewer);
    return {
      status: detail?.status,
      count: detail?.pending_request_count,
      listed: (await service.listPendingRequests(owner, sessionId)).items.map(
        (item) => item.request_id,
      ),
      filteredNeedsInput: await filtered("needs_input"),
      filteredIdle: await filtered("idle"),
      countedNeedsInput: counted.counts.needs_input,
      countedIdle: counted.counts.idle,
    };
  }

  test("a parked request stays listed, counted and needs_input after its attempt is gone", async () => {
    const { owner, sessionId, worker, requestId } = await parked();
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(attempt?.state).toBe("lost");
    expect((await request(requestId)).resolvedAt).toBeNull();
    expect(await reads(owner, sessionId)).toEqual({
      status: "needs_input",
      count: 1,
      listed: [requestId],
      filteredNeedsInput: 1,
      filteredIdle: 0,
      countedNeedsInput: 1,
      countedIdle: 0,
    });

    // Expired, it is answerable no more and the session reads idle again.
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    expect(await reads(owner, sessionId)).toEqual({
      status: "idle",
      count: 0,
      listed: [],
      filteredNeedsInput: 0,
      filteredIdle: 1,
      countedNeedsInput: 0,
      countedIdle: 1,
    });
    expect(await failure(answer(owner, sessionId, requestId))).toBe(
      "REQUEST_EXPIRED",
    );
  });

  test("execution-gone closes the waiting request and keeps the parked one", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const kept = await register(worker, HASH_A);
    const lost = await register(worker, HASH_B);
    await parkRows(worker, [kept]);
    await executionGone(worker);

    expect((await request(kept)).resolvedAt).toBeNull();
    expect((await request(lost)).resolvedAt).not.toBeNull();
    expect((await reads(owner, sessionId)).listed).toEqual([kept]);
    // Its asker is gone: an answer to the request that was not parked is
    // stale, one to the parked request is taken.
    expect(await failure(answer(owner, sessionId, lost))).toBe("REQUEST_STALE");
    const accepted = await answer(owner, sessionId, kept);
    expect(accepted.receipt_status).toBe("accepted");
    expect((await receipt(accepted.receipt_id))?.targetRef).toEqual({
      session_id: sessionId,
      turn_id: "1",
      request_id: kept,
    });
    expect((await request(kept)).resolvedAt).not.toBeNull();
    expect((await reads(owner, sessionId)).count).toBe(0);
  });

  test("an answered parked request is not lost when the execution goes", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const parkedId = await register(worker, HASH_A);
    const waitingId = await register(worker, HASH_B);
    const parkedAnswer = await answer(owner, sessionId, parkedId);
    const waitingAnswer = await answer(owner, sessionId, waitingId);
    await parkRows(worker, [parkedId]);
    await executionGone(worker);

    expect(await request(parkedId)).toMatchObject({
      settledAt: null,
      settledOutcome: null,
    });
    expect((await receipt(parkedAnswer.receipt_id))?.status).toBe("accepted");
    expect((await request(waitingId)).settledOutcome).toBe("lost");
    expect((await receipt(waitingAnswer.receipt_id))?.status).toBe("unknown");
  });

  test("the worker cannot settle a parked request", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const accepted = await answer(owner, sessionId, requestId);
    await db
      .update(pendingRequests)
      .set({ parkedAt: sql`now()` })
      .where(eq(pendingRequests.requestId, requestId));
    // Nor is its answer handed to the attempt that asked, which may still
    // be up between the park's finalize and its release.
    const polled = await poll(worker, [
      { request_id: requestId, outcome: "cancelled" },
    ]);
    expect(polled.answers).toEqual([]);
    expect(await request(requestId)).toMatchObject({
      settledAt: null,
      settledOutcome: null,
      deliveredAt: null,
    });
    expect((await receipt(accepted.receipt_id))?.status).toBe("accepted");
  });

  test("a park that settles paused reports the session waiting for input", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    const turnRowId = await parkRows(worker, [requestId]);
    await db.insert(checkpoints).values({
      sessionId,
      revision: 0,
      manifestRef: `manifests/${sessionId}/0`,
      manifestSha256: "c".repeat(64),
      parentRevision: null,
      turnId: turnRowId,
    });
    await db
      .update(sessions)
      .set({
        checkpointRevision: 0,
        admissionState: "pausing",
        pauseReason: "awaiting_input",
        status: "idle",
      })
      .where(eq(sessions.id, sessionId));
    await db.insert(receipts).values({
      id: crypto.randomUUID(),
      ownerId: owner.ownerId,
      actor: { kind: "system" },
      requestId: null,
      operation: "pause",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "accepted",
      result: null,
    });
    await executionGone(worker);

    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: "awaiting_input",
      inputAnnounced: true,
    });
    const [last] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(last?.payload).toMatchObject({
      phase: "needs_input",
      admission_state: "paused",
    });
    expect((await reads(owner, sessionId)).status).toBe("needs_input");
  });

  test("pendingControl stamps delivered_at once, when it first hands an answer over", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await answer(owner, sessionId, requestId);
    expect((await request(requestId)).deliveredAt).toBeNull();

    expect((await poll(worker)).answers).toHaveLength(1);
    const first = (await request(requestId)).deliveredAt;
    expect(first).toBeInstanceOf(Date);
    // Redelivered until settled; the first hand-over is what it records.
    expect((await poll(worker)).answers).toHaveLength(1);
    expect((await request(requestId)).deliveredAt).toEqual(first);

    // A request nobody answered is never delivered.
    const unanswered = await register(worker, HASH_B);
    await poll(worker);
    expect((await request(unanswered)).deliveredAt).toBeNull();
  });

  test("a revocation before the park's execution is gone still reports the wait", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const requestId = await register(worker);
    await parkRows(worker, [requestId]);
    await db
      .update(sessions)
      .set({
        admissionState: "pausing",
        pauseReason: "awaiting_input",
        status: "idle",
      })
      .where(eq(sessions.id, sessionId));
    expect(
      (
        await revokeExecutionAtomic(db, {
          sessionId,
          reason: "grant revoked",
          now: new Date(),
        })
      ).outcome,
    ).toBe("revoked");

    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "stopping",
      inputAnnounced: true,
    });
    const [last] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(last?.payload).toMatchObject({
      phase: "needs_input",
      admission_state: "stopping",
    });
    expect(await reads(owner, sessionId)).toMatchObject({
      status: "needs_input",
      count: 1,
    });
  });

  test("an execution revocation keeps a parked request; a terminate cancels it", async () => {
    const revoked = await parked();
    expect(
      (
        await revokeExecutionAtomic(db, {
          sessionId: revoked.sessionId,
          reason: "grant revoked",
          now: new Date(),
        })
      ).outcome,
    ).toBe("revoked");
    expect(await request(revoked.requestId)).toMatchObject({
      resolvedAt: null,
      settledAt: null,
    });

    const terminated = await parked();
    const accepted = await answer(
      terminated.owner,
      terminated.sessionId,
      terminated.requestId,
    );
    const row = await sessionRow(terminated.sessionId);
    const killed = await controls().terminateAtomic({
      principal: terminated.owner,
      sessionId: terminated.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "done",
      now: new Date(),
    });
    expect(killed.outcome).toBe("accepted");
    expect(await request(terminated.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
    expect((await receipt(accepted.receipt_id))?.status).toBe("failed");
    expect(await sessionRow(terminated.sessionId)).toMatchObject({
      admissionState: "stopped",
      pauseReason: null,
    });
  });

  test("a close, an interrupt or a recovery close cancels the parked requests", async () => {
    const closed = await parked();
    const row = await sessionRow(closed.sessionId);
    const close = await controls().closeAtomic({
      principal: closed.owner,
      sessionId: closed.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row.revision,
      reason: "work is done",
      now: new Date(),
    });
    expect(close.outcome).toBe("accepted");
    expect(await request(closed.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
    expect(await sessionRow(closed.sessionId)).toMatchObject({
      admissionState: "closed",
      pauseReason: null,
    });

    const interrupted = await parked();
    const interrupt = await createPostgresTurnInterrupts(db).interruptAtomic({
      principal: interrupted.owner,
      sessionId: interrupted.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      targetTurnId: "1",
    });
    expect(interrupt.outcome).toBe("accepted");
    expect(await request(interrupted.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
    expect((await reads(interrupted.owner, interrupted.sessionId)).status).toBe(
      "idle",
    );

    const recovered = await parked();
    await db
      .update(sessions)
      .set({ admissionState: "recovery_required", status: "failed" })
      .where(eq(sessions.id, recovered.sessionId));
    const before = await sessionRow(recovered.sessionId);
    const decided = await controls().decideRecoveryAtomic({
      principal: recovered.owner,
      sessionId: recovered.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      decision: {
        decision: "close",
        expected_revision: before.revision,
        reason: "give up",
      },
      now: new Date(),
    });
    expect(decided.outcome).toBe("accepted");
    expect(await request(recovered.requestId)).toMatchObject({
      settledOutcome: "cancelled",
    });
  });

  test("the reconciler does not report a parked wait as ended", async () => {
    const { sessionId } = await parked();
    await db
      .update(sessions)
      .set({ inputAnnounced: true })
      .where(eq(sessions.id, sessionId));
    const announced = await announceLapsedInputWaits(db, {
      limit: 1_000,
      dryRun: true,
    });
    expect(announced.map((item) => item.sessionId)).not.toContain(sessionId);
  });

  test("pause_reason holds only while pausing or paused", async () => {
    const { sessionId } = await parked();
    // Leaving paused by any write clears it.
    await db
      .update(sessions)
      .set({ admissionState: "active" })
      .where(eq(sessions.id, sessionId));
    expect((await sessionRow(sessionId)).pauseReason).toBeNull();
    // Set outside a pause, it does not stick.
    await db
      .update(sessions)
      .set({ pauseReason: "awaiting_input" })
      .where(eq(sessions.id, sessionId));
    expect((await sessionRow(sessionId)).pauseReason).toBeNull();
    // No trigger runs on an insert: the check refuses it outright.
    const refused = await db
      .insert(sessions)
      .values({
        id: crypto.randomUUID(),
        ownerId: "owner-check",
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        pauseReason: "awaiting_input",
      })
      .then(
        () => null,
        (error: { cause?: { constraint?: string } }) => error.cause?.constraint,
      );
    expect(refused).toBe("sessions_pause_reason_check");
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, sessionId));
    await expect(
      db
        .update(sessions)
        .set({ pauseReason: "parked" })
        .where(eq(sessions.id, sessionId))
        .execute(),
    ).rejects.toThrow();
  });

  test("a person's pause takes over a park, paused or still pausing", async () => {
    const paused = await parked();
    const before = await sessionRow(paused.sessionId);
    const taken = await controls().pauseAtomic({
      principal: paused.owner,
      sessionId: paused.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: before.revision,
      reason: "mine now",
      now: new Date(),
    });
    expect(taken.outcome).toBe("accepted");
    if (taken.outcome !== "accepted") return;
    expect(taken.response.receipt_status).toBe("succeeded");
    expect(await sessionRow(paused.sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: null,
      revision: before.revision + 1,
    });
    // The parked request is still the person's to answer.
    expect((await reads(paused.owner, paused.sessionId)).count).toBe(1);

    // Pausing: the park's receipt is superseded and the worker is handed
    // the person's pause as a new control.
    const { owner, sessionId, worker } = await runningSession();
    await register(worker);
    const parkReceipt = crypto.randomUUID();
    await db.insert(receipts).values({
      id: parkReceipt,
      ownerId: owner.ownerId,
      actor: { kind: "system" },
      requestId: null,
      operation: "pause",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "accepted",
      result: null,
    });
    await db
      .update(sessions)
      .set({ admissionState: "pausing", pauseReason: "awaiting_input" })
      .where(eq(sessions.id, sessionId));
    expect((await poll(worker)).control?.control_id).toBe(parkReceipt);
    const pausing = await sessionRow(sessionId);
    // A park waits on its open requests by design; only the turn holds it.
    expect(await pauseBlocker(db, pausing)).toBe("long_turn");
    expect(await pauseBlocker(db, { ...pausing, pauseReason: null })).toBe(
      "pending_request",
    );

    const takeover = await controls().pauseAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: pausing.revision,
      reason: "mine now",
      now: new Date(),
    });
    expect(takeover.outcome).toBe("accepted");
    if (takeover.outcome !== "accepted") return;
    expect(takeover.response.receipt_status).toBe("accepted");
    expect(await receipt(parkReceipt)).toMatchObject({
      status: "failed",
      error: { code: "CONTROL_SUPERSEDED" },
    });
    expect((await poll(worker)).control).toMatchObject({
      control_id: takeover.response.receipt_id,
      kind: "pause",
    });
    expect(await sessionRow(sessionId)).toMatchObject({
      admissionState: "pausing",
      pauseReason: null,
    });
  });

  test("a grant goes with its session and its request", async () => {
    const result = await pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'permission_grants'::regclass AND contype = 'f'
       ORDER BY conname`,
    );
    expect(result.rows).toEqual([
      {
        conname: "permission_grants_request_id_pending_requests_request_id_fk",
        confdeltype: "c",
      },
      {
        conname: "permission_grants_session_id_sessions_id_fk",
        confdeltype: "c",
      },
      { conname: "permission_grants_turn_id_turns_id_fk", confdeltype: "a" },
    ]);

    const { sessionId, requestId, turnRowId } = await parked();
    await db.insert(permissionGrants).values({
      requestId,
      sessionId,
      turnId: turnRowId,
    });
    await db
      .delete(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(
      await db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.sessionId, sessionId)),
    ).toEqual([]);
  });
});
