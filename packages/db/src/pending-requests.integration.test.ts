import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  PendingSettlement,
  PostSessionAnswerRequest,
  RegisterPendingRequest,
  WorkerScope,
} from "@agent-platform/contracts";
import {
  createPendingRequestService,
  createWorkerGateway,
  ownerScopedPolicy,
  payloadHash,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresTurnInterrupts } from "./interrupt-control.ts";
import { reconcileExpiredLeases } from "./lease-reconcile.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  events,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { announceLapsedInputWaits } from "./session-events.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LEASE_TTL_MS = 60_000;
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

const QUESTION: RegisterPendingRequest["request"] = {
  kind: "question",
  questions: [
    {
      question_id: "q0",
      prompt: "Which environment?",
      options: [
        { option_id: "q0o0", label: "staging" },
        { option_id: "q0o1", label: "production" },
      ],
      multi_select: false,
      allow_free_text: false,
    },
  ],
};

function permission(command = "ls"): RegisterPendingRequest["request"] {
  return { kind: "permission", tool: "Bash", input: { command } };
}

integration("pending requests and answers on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let service: ReturnType<typeof createPendingRequestService>;

  const gatewayWith = (pendingTtlMs?: number) =>
    createWorkerGateway({
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
        leaseTtlMs: LEASE_TTL_MS,
        sleep: async () => {},
        ...(pendingTtlMs === undefined ? {} : { pendingTtlMs }),
      },
    });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pending_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
    gateway = gatewayWith();
    service = createPendingRequestService({
      authorization: ownerScopedPolicy,
      store: createPostgresPendingRequests(db),
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function partitionFor(name: string) {
    return `${name}-${crypto.randomUUID()}`;
  }

  async function launch(partition: string) {
    const executionId = `exec-${crypto.randomUUID()}`;
    const registered = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      backend: "local_docker",
    });
    if (registered.nonce === null) throw new Error("launch already registered");
    return { executionId, nonce: registered.nonce };
  }

  type Worker = {
    principal: WorkerPrincipal;
    scope: WorkerScope;
    executionId: string;
  };

  async function claimAndDeliver(partition: string): Promise<Worker> {
    const l = await launch(partition);
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: l.nonce },
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
    return {
      principal,
      scope: { ...scope, turn_id: next.input.turn_id },
      executionId: l.executionId,
    };
  }

  // A session whose first turn is running on a worker.
  async function runningSession() {
    const partition = partitionFor("pending");
    const owner = { ownerId: `owner-${crypto.randomUUID()}` };
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
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const worker = await claimAndDeliver(partition);
    expect(worker.scope.session_id).toBe(sessionId);
    return { owner, sessionId, partition, worker };
  }

  async function register(
    worker: Worker,
    request: RegisterPendingRequest["request"],
    inputHash = HASH_A,
    requestId = `req_${crypto.randomUUID()}`,
    via: WorkerGateway = gateway,
  ) {
    const response = await via.registerPending(worker.principal, {
      ...(worker.scope as WorkerScope & { turn_id: string }),
      request_id: requestId,
      input_hash: inputHash,
      request,
    });
    return { requestId, response };
  }

  function answer(
    owner: { ownerId: string },
    sessionId: string,
    body: PostSessionAnswerRequest,
    key = crypto.randomUUID(),
  ) {
    return service.answer(owner, sessionId, { idempotencyKey: key, body });
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof SessionServiceError) return error.code;
      if (error instanceof WorkerGatewayError) return error.code;
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  async function receiptOf(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  function poll(
    worker: Worker,
    answersAfter = 0,
    settled: PendingSettlement[] = [],
  ) {
    return gateway.pendingControl(worker.principal, {
      ...worker.scope,
      answers_after: answersAfter,
      settled,
    });
  }

  test("lists what the worker registered, in the public shape, to its owner only", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const tool = await register(worker, permission("ls -la"));
    const asked = await register(worker, QUESTION, HASH_B);
    expect(tool.response.expires_in_ms).toBe(30 * 60_000);

    const listed = await service.listPendingRequests(owner, sessionId);
    expect(listed.items).toHaveLength(2);
    const byId = new Map(listed.items.map((item) => [item.request_id, item]));
    expect(byId.get(tool.requestId)).toEqual({
      request_id: tool.requestId,
      kind: "permission",
      turn_id: "1",
      attempt_id: worker.scope.attempt_id,
      tool: "Bash",
      input: { command: "ls -la" },
      created_at: expect.any(String),
      expires_at: tool.response.expires_at,
    });
    expect(byId.get(asked.requestId)).toMatchObject({
      kind: "question",
      turn_id: "1",
      questions: QUESTION.kind === "question" ? QUESTION.questions : [],
    });
    // The summary counts exactly what the list shows.
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    expect(detail?.pending_request_count).toBe(2);

    expect(
      await failure(
        service.listPendingRequests({ ownerId: "someone-else" }, sessionId),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await failure(
        answer({ ownerId: "someone-else" }, sessionId, {
          request_id: tool.requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("an answer is stored, handed to its attempt, and succeeds once the worker says it landed", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    const body: PostSessionAnswerRequest = {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    };
    const key = crypto.randomUUID();
    const accepted = await answer(owner, sessionId, body, key);
    expect(accepted.receipt_status).toBe("accepted");
    expect((await receiptOf(accepted.receipt_id))?.targetRef).toEqual({
      session_id: sessionId,
      turn_id: "1",
      request_id: requestId,
    });
    // Answered is closed to clients.
    expect(
      (await service.listPendingRequests(owner, sessionId)).items,
    ).toHaveLength(0);

    const beat = await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
    });
    expect(beat.control_pending).toBe(true);
    const delivered = await poll(worker);
    expect(delivered.answers).toEqual([
      { sequence: 1, answer: body, input_hash: HASH_A },
    ]);
    // Redelivered until settled, whatever the cursor says.
    expect((await poll(worker, 1)).answers).toEqual([]);
    expect((await poll(worker, 0)).answers).toHaveLength(1);

    await poll(worker, 1, [{ request_id: requestId, outcome: "answered" }]);
    expect((await receiptOf(accepted.receipt_id))?.status).toBe("succeeded");
    expect((await poll(worker, 0)).answers).toEqual([]);
    const after = await gateway.heartbeat(worker.principal, {
      ...worker.scope,
      attempt_state: "running",
    });
    expect(after.control_pending).toBe(false);

    // The same key replays the original receipt at its current status; a
    // different body under it is a conflict, not a second answer.
    expect(await answer(owner, sessionId, body, key)).toEqual({
      receipt_id: accepted.receipt_id,
      receipt_status: "succeeded",
    });
    expect(
      await failure(
        answer(
          owner,
          sessionId,
          { ...body, decision: "deny", reason: "no" },
          key,
        ),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    // A new key on an answered request is too late.
    expect(await failure(answer(owner, sessionId, body))).toBe(
      "REQUEST_EXPIRED",
    );
  });

  test("refuses options the request never offered, and answers of the other kind", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, QUESTION);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "question",
          answers: [{ question_id: "q0", selected_option_ids: ["q0o9"] }],
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "question",
          answers: [
            {
              question_id: "q0",
              selected_option_ids: [],
              free_text: "this question takes none",
            },
          ],
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: "req_never-registered",
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("NOT_FOUND");
    // None of those took the request.
    const good = await answer(owner, sessionId, {
      request_id: requestId,
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o1"] }],
    });
    expect(good.receipt_status).toBe("accepted");
  });

  test("a request past its expiry, or one the worker gave up on, is REQUEST_EXPIRED", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const brief = gatewayWith(1);
    const { requestId: late } = await register(
      worker,
      permission(),
      HASH_A,
      undefined,
      brief,
    );
    await Bun.sleep(5);
    expect(
      (await service.listPendingRequests(owner, sessionId)).items,
    ).toHaveLength(0);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: late,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("REQUEST_EXPIRED");

    const { requestId: dropped } = await register(worker, permission("pwd"));
    await poll(worker, 0, [{ request_id: dropped, outcome: "expired" }]);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: dropped,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("REQUEST_EXPIRED");
  });

  test("a registration replays with what is left of its lifetime and is never reopened", async () => {
    const { worker } = await runningSession();
    const first = await register(worker, permission());
    const again = await register(worker, permission(), HASH_A, first.requestId);
    expect(again.response.expires_at).toBe(first.response.expires_at);
    expect(again.response.expires_in_ms).toBeLessThanOrEqual(
      first.response.expires_in_ms,
    );
    expect(
      await failure(register(worker, permission(), HASH_B, first.requestId)),
    ).toBe("IDEMPOTENCY_CONFLICT");
    await poll(worker, 0, [
      { request_id: first.requestId, outcome: "cancelled" },
    ]);
    expect(
      await failure(register(worker, permission(), HASH_A, first.requestId)),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      await failure(
        gateway.registerPending(worker.principal, {
          ...(worker.scope as WorkerScope & { turn_id: string }),
          turn_id: "2",
          request_id: `req_${crypto.randomUUID()}`,
          input_hash: HASH_A,
          request: permission(),
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  test("a registration whose reply was lost still replays after its turn closed", async () => {
    const { sessionId, worker } = await runningSession();
    const first = await register(worker, permission());
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, sessionId));
    const again = await register(worker, permission(), HASH_A, first.requestId);
    expect(again.response.expires_at).toBe(first.response.expires_at);
    // The closed turn takes nothing new.
    expect(await failure(register(worker, permission()))).toBe("NOT_FOUND");
  });

  test("two requests answered in reverse order each get their own answer", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const first = await register(worker, permission("ls"), HASH_A);
    const second = await register(worker, permission("rm -rf /"), HASH_B);
    const deny: PostSessionAnswerRequest = {
      request_id: second.requestId,
      kind: "permission",
      decision: "deny",
      reason: "Not here",
    };
    const allow: PostSessionAnswerRequest = {
      request_id: first.requestId,
      kind: "permission",
      decision: "allow",
    };
    await answer(owner, sessionId, deny);
    await answer(owner, sessionId, allow);

    const delivered = await poll(worker);
    expect(delivered.answers).toEqual([
      { sequence: 1, answer: deny, input_hash: HASH_B },
      { sequence: 2, answer: allow, input_hash: HASH_A },
    ]);
  });

  test("concurrent answers get one gapless sequence per session", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const registered = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        register(worker, permission(`echo ${index}`)),
      ),
    );
    await Promise.all(
      registered.map(({ requestId }) =>
        answer(owner, sessionId, {
          request_id: requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    );
    const delivered = await poll(worker);
    expect(delivered.answers.map((item) => item.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(new Set(delivered.answers.map((a) => a.answer.request_id))).toEqual(
      new Set(registered.map((r) => r.requestId)),
    );
  });

  test("a replaced worker's requests go stale, and only the new attempt's reach it", async () => {
    const { owner, sessionId, partition, worker } = await runningSession();
    const open = await register(worker, permission("ls"));
    const handed = await register(worker, permission("pwd"));
    const handedReceipt = await answer(owner, sessionId, {
      request_id: handed.requestId,
      kind: "permission",
      decision: "allow",
    });
    await poll(worker);

    // The worker goes away without saying what became of the answer.
    await gateway.release(worker.principal, {
      ...worker.scope,
      turn_id: null,
      reason: "replaced",
    });
    expect(
      (await service.listPendingRequests(owner, sessionId)).items,
    ).toHaveLength(0);
    expect(
      await failure(
        answer(owner, sessionId, {
          request_id: open.requestId,
          kind: "permission",
          decision: "allow",
        }),
      ),
    ).toBe("REQUEST_STALE");
    await gateway.confirmExecutionGone(worker.executionId);
    // It may have reached the callback before the worker died.
    const lost = await receiptOf(handedReceipt.receipt_id);
    expect(lost?.status).toBe("unknown");
    expect(lost?.error).toMatchObject({ code: "REQUEST_STALE" });

    // What an operator's recovery decision leaves behind (94S-140): the
    // unknown turn settled and off the queue, the session taking input again.
    await db
      .update(turns)
      .set({ status: "cancelled" })
      .where(eq(turns.sessionId, sessionId));
    await db
      .delete(queueMessages)
      .where(eq(queueMessages.sessionId, sessionId));
    await db
      .update(sessions)
      .set({ admissionState: "active", status: "idle" })
      .where(eq(sessions.id, sessionId));
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    await db
      .insert(unassignedSessions)
      .values({ sessionId, partition })
      .onConflictDoUpdate({
        target: unassignedSessions.sessionId,
        set: { partition },
      });
    const replacement = await claimAndDeliver(partition);
    expect(replacement.scope.attempt_id).not.toBe(worker.scope.attempt_id);
    expect(replacement.scope.turn_id).toBe("2");

    // The engine asks again, under a new id, on the new attempt.
    const again = await register(replacement, permission("ls"));
    const listed = await service.listPendingRequests(owner, sessionId);
    expect(listed.items.map((item) => item.request_id)).toEqual([
      again.requestId,
    ]);
    expect(listed.items[0]?.attempt_id).toBe(replacement.scope.attempt_id);
    await answer(owner, sessionId, {
      request_id: again.requestId,
      kind: "permission",
      decision: "allow",
    });
    const delivered = await poll(replacement);
    expect(delivered.answers.map((item) => item.answer.request_id)).toEqual([
      again.requestId,
    ]);
    // The old attempt hears nothing, and cannot ask any more either.
    expect(await failure(poll(worker))).toBe("STALE_EPOCH");
    expect(await failure(register(worker, permission("ls")))).toBe(
      "STALE_EPOCH",
    );
  });

  test("a poll past the lease settles nothing and delivers nothing", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    const accepted = await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(
      await failure(
        poll(worker, 0, [{ request_id: requestId, outcome: "answered" }]),
      ),
    ).toBe("LEASE_EXPIRED");
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(row?.settledAt).toBeNull();
    expect((await receiptOf(accepted.receipt_id))?.status).toBe("accepted");
  });

  test("a settlement that says the answer was dropped fails its receipt", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    const accepted = await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    // A late or unknown settlement, then the real one, then a contradicting
    // repeat: the first word on a request stands.
    await poll(worker, 0, [
      { request_id: "req_unknown", outcome: "answered" },
      { request_id: requestId, outcome: "expired" },
    ]);
    await poll(worker, 0, [{ request_id: requestId, outcome: "answered" }]);
    const receipt = await receiptOf(accepted.receipt_id);
    expect(receipt?.status).toBe("failed");
    expect(receipt?.error).toMatchObject({ code: "REQUEST_EXPIRED" });
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(row?.settledOutcome).toBe("expired");
    expect(payloadHash(row?.answer)).toBe(
      payloadHash({
        request_id: requestId,
        kind: "permission",
        decision: "allow",
      }),
    );
  });

  // What each reader says, next to what the columns hold.
  async function statuses(owner: { ownerId: string }, sessionId: string) {
    const reader = createPostgresSessionReader(db);
    const detail = await reader.getSession(owner.ownerId, sessionId);
    const turn = await reader.getTurn(owner.ownerId, sessionId, "1");
    const turnList = await reader.listTurns(owner.ownerId, sessionId, {
      limit: 10,
    });
    const listed = await reader.listSessions(owner.ownerId, { limit: 10 });
    const filtered = async (status: "needs_input" | "running") =>
      (await reader.listSessions(owner.ownerId, { limit: 10, status })).items
        .length;
    const [stored] = await db
      .select({ session: sessions.status, turn: turns.status })
      .from(sessions)
      .innerJoin(turns, eq(turns.sessionId, sessions.id))
      .where(and(eq(sessions.id, sessionId), eq(turns.sequence, 1)));
    return {
      session: detail?.status,
      count: detail?.pending_request_count,
      turn: turn?.status,
      turnListed: turnList?.items[0]?.status,
      listed: listed.items[0]?.status,
      filteredNeedsInput: await filtered("needs_input"),
      filteredRunning: await filtered("running"),
      stored,
    };
  }

  const WAITING = {
    session: "needs_input",
    turn: "needs_input",
    turnListed: "needs_input",
    listed: "needs_input",
    filteredNeedsInput: 1,
    filteredRunning: 0,
    // Never written: the columns keep saying what the execution is doing.
    stored: { session: "running", turn: "running" },
  } as const;
  const RUNNING = {
    session: "running",
    count: 0,
    turn: "running",
    turnListed: "running",
    listed: "running",
    filteredNeedsInput: 0,
    filteredRunning: 1,
    stored: { session: "running", turn: "running" },
  } as const;

  test("needs_input holds while any request waits and lifts once the last is answered or settled", async () => {
    const { owner, sessionId, worker } = await runningSession();
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);

    const asked = await register(worker, permission("ls"));
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });
    const other = await register(worker, QUESTION, HASH_B);
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 2 });

    // One answered, one left: still waiting on a person.
    await answer(owner, sessionId, {
      request_id: asked.requestId,
      kind: "permission",
      decision: "allow",
    });
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });

    // The worker gives up on the other one (its callback went away).
    await poll(worker, 0, [
      { request_id: other.requestId, outcome: "cancelled" },
    ]);
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);
  });

  test("needs_input lifts when the last request expires, with nothing written", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });
    // Time passing, without waiting for it: only the deadline moves.
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);
    const [row] = await db
      .select()
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    expect(row?.resolvedAt).toBeNull();
  });

  test("expiry is judged at each statement, not at the start of a longer transaction", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    await db.transaction(async (tx) => {
      await tx
        .update(pendingRequests)
        .set({ expiresAt: sql`clock_timestamp() + interval '1 second'` })
        .where(eq(pendingRequests.requestId, requestId));
      const reader = createPostgresSessionReader(tx);
      const before = await reader.getSession(owner.ownerId, sessionId);
      expect(before?.status).toBe("needs_input");
      await tx.execute(sql`SELECT pg_sleep(1.2)`);
      const after = await reader.getSession(owner.ownerId, sessionId);
      expect(after?.status).toBe("running");
      expect(after?.pending_request_count).toBe(0);
    });
  });

  test("a stored needs_input reads from the pending requests like running does", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await db
      .update(sessions)
      .set({ status: "needs_input" })
      .where(eq(sessions.id, sessionId));
    const legacy = {
      stored: { session: "needs_input", turn: "running" },
    } as const;
    expect(await statuses(owner, sessionId)).toEqual({ ...RUNNING, ...legacy });
    await register(worker, permission());
    expect(await statuses(owner, sessionId)).toEqual({
      ...WAITING,
      ...legacy,
      count: 1,
    });
  });

  test("an epoch, generation or auth rotation drops the old attempt's requests while its lease still runs", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await register(worker, permission());
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("session row missing");
    for (const moved of [
      { leaseEpoch: session.leaseEpoch + 1 },
      { executionGeneration: session.executionGeneration + 1 },
      { authRevision: session.authRevision + 1 },
    ]) {
      expect(await statuses(owner, sessionId)).toEqual({
        ...WAITING,
        count: 1,
      });
      await db.update(sessions).set(moved).where(eq(sessions.id, sessionId));
      expect(await statuses(owner, sessionId)).toEqual(RUNNING);
      await db
        .update(sessions)
        .set({
          leaseEpoch: session.leaseEpoch,
          executionGeneration: session.executionGeneration,
          authRevision: session.authRevision,
        })
        .where(eq(sessions.id, sessionId));
    }
  });

  test("a lapsed or fenced attempt's requests stop holding the session in needs_input", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await register(worker, permission());
    expect(await statuses(owner, sessionId)).toEqual({ ...WAITING, count: 1 });

    // The lease running out is enough, before any reconciler pass.
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);

    // The reconciler fences it (epoch bump, kill requested) without touching
    // the turn; nothing brings needs_input back.
    await reconcileExpiredLeases(db, {});
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, worker.scope.attempt_id));
    expect(attempt?.state).toBe("lost");
    expect(await statuses(owner, sessionId)).toEqual(RUNNING);
  });
  // 94S-278: the stream reports the needs_input edges the reads derive.
  async function ask(
    worker: Worker,
    request: RegisterPendingRequest["request"],
    options: {
      requestId?: string;
      inputHash?: string;
      toolUseId?: string;
    } = {},
  ) {
    const requestId = options.requestId ?? `req_${crypto.randomUUID()}`;
    const response = await gateway.registerPending(worker.principal, {
      ...(worker.scope as WorkerScope & { turn_id: string }),
      request_id: requestId,
      input_hash: options.inputHash ?? HASH_A,
      request,
      announce: {
        tool_use_id: options.toolUseId ?? `toolu_${requestId}`,
        tool: request.kind === "permission" ? request.tool : "AskUserQuestion",
      },
    });
    return { requestId, response };
  }

  // The session's stream as a client reads it, reduced to what orders.
  async function stream(sessionId: string) {
    const rows = await db
      .select({
        type: events.type,
        payload: events.payload,
        attemptId: events.attemptId,
        turnId: events.turnId,
      })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.id));
    return rows.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      return row.type === "status"
        ? `status:${payload.phase}`
        : row.type === "question"
          ? `question:${payload.request_id}`
          : row.type;
    });
  }

  async function announced(sessionId: string) {
    const [row] = await db
      .select({ flag: sessions.inputAnnounced })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row?.flag;
  }

  test("a question and the needs_input it opens are written together, question first, once", async () => {
    const { sessionId, worker } = await runningSession();
    const first = await ask(worker, permission("ls"), {
      toolUseId: "toolu_first",
    });
    expect(await stream(sessionId)).toEqual([
      `question:${first.requestId}`,
      "status:needs_input",
    ]);
    const [question] = await db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "question")));
    expect(question?.payload).toEqual({
      request_id: first.requestId,
      tool_use_id: "toolu_first",
      kind: "permission",
      tool: "Bash",
      input: { command: "ls" },
      expires_at: first.response.expires_at,
    });
    // It belongs to the attempt that asked and its turn, but takes no place
    // in that attempt's own numbering.
    expect(question?.attemptId).toBe(worker.scope.attempt_id);
    expect(question?.turnId).not.toBeNull();
    expect(question?.sourceSequence).toBeNull();
    expect(await announced(sessionId)).toBe(true);

    // A second question while waiting opens nothing new.
    const second = await ask(worker, QUESTION, { inputHash: HASH_B });
    // A registration whose reply was lost comes back: nothing is rewritten.
    await ask(worker, permission("ls"), {
      requestId: first.requestId,
      toolUseId: "toolu_first",
    });
    expect(await stream(sessionId)).toEqual([
      `question:${first.requestId}`,
      "status:needs_input",
      `question:${second.requestId}`,
    ]);
    // The same id under another tool use is another request.
    expect(
      await failure(
        ask(worker, permission("ls"), {
          requestId: first.requestId,
          toolUseId: "toolu_other",
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    const [secondEvent] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          sql`${events.payload}->>'request_id' = ${second.requestId}`,
        ),
      );
    expect(secondEvent?.payload).toMatchObject({
      kind: "question",
      tool: "AskUserQuestion",
      input: {
        questions: QUESTION.kind === "question" ? QUESTION.questions : [],
      },
    });
  });

  test("the answer or settlement that leaves nothing to answer reports running, once", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const first = await ask(worker, permission());
    const second = await ask(worker, permission("pwd"), { inputHash: HASH_B });
    const key = crypto.randomUUID();
    await answer(
      owner,
      sessionId,
      { request_id: first.requestId, kind: "permission", decision: "allow" },
      key,
    );
    // One is still open.
    expect((await stream(sessionId)).slice(3)).toEqual([]);

    await poll(worker, 0, [
      { request_id: second.requestId, outcome: "cancelled" },
    ]);
    const settledOnce = [
      `question:${first.requestId}`,
      "status:needs_input",
      `question:${second.requestId}`,
      "status:running",
    ];
    expect(await stream(sessionId)).toEqual(settledOnce);
    expect(await announced(sessionId)).toBe(false);
    // It is about the turn whose request the settlement closed.
    const [pendingRow] = await db
      .select({ turnId: pendingRequests.turnId })
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, second.requestId));
    const [returned] = await db
      .select({ turnId: events.turnId })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")))
      .orderBy(desc(events.id))
      .limit(1);
    expect(returned?.turnId).toBe(pendingRow?.turnId ?? -1);

    // Repeats close nothing that was open: the answer's replay, the same
    // settlement again, and the answered row's own settlement.
    await answer(
      owner,
      sessionId,
      { request_id: first.requestId, kind: "permission", decision: "allow" },
      key,
    );
    await poll(worker, 0, [
      { request_id: second.requestId, outcome: "cancelled" },
      { request_id: first.requestId, outcome: "answered" },
    ]);
    expect(await stream(sessionId)).toEqual(settledOnce);
  });

  test("an answer that closes the last request reports running in its own transaction", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "deny",
    });
    expect(await stream(sessionId)).toEqual([
      `question:${requestId}`,
      "status:needs_input",
      "status:running",
    ]);
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    expect(detail?.status).toBe("running");
  });

  test("an expiry is reported once by the reconciler, not by the settlement that follows it", async () => {
    const { sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    // The worker's own timer settles it: the wait had already ended.
    await poll(worker, 0, [{ request_id: requestId, outcome: "expired" }]);
    expect(await stream(sessionId)).toEqual([
      `question:${requestId}`,
      "status:needs_input",
    ]);

    const swept = await announceLapsedInputWaits(db, {
      limit: 1_000,
      dryRun: false,
    });
    expect(swept).toContainEqual({ sessionId, phase: "running" });
    await announceLapsedInputWaits(db, { limit: 1_000, dryRun: false });
    expect(await stream(sessionId)).toEqual([
      `question:${requestId}`,
      "status:needs_input",
      "status:running",
    ]);
  });

  test("a dry run reports the lapsed wait and writes nothing", async () => {
    const { sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, requestId));
    const swept = await announceLapsedInputWaits(db, {
      limit: 1_000,
      dryRun: true,
    });
    expect(swept).toContainEqual({ sessionId, phase: "running" });
    expect(await stream(sessionId)).toHaveLength(2);
    expect(await announced(sessionId)).toBe(true);
  });

  test("a lost attempt's wait is reported by the reconciler with the status the session reads", async () => {
    const { owner, sessionId, worker } = await runningSession();
    await ask(worker, permission());
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(attempts.id, worker.scope.attempt_id));
    await reconcileExpiredLeases(db, {});
    await announceLapsedInputWaits(db, { limit: 1_000, dryRun: false });
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    expect((await stream(sessionId)).at(-1)).toBe(`status:${detail?.status}`);
    expect(detail?.status).toBe("running");
  });

  test("a new question after a wait that lapsed unreported reports the lapse first", async () => {
    const { sessionId, worker } = await runningSession();
    const first = await ask(worker, permission());
    await db
      .update(pendingRequests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pendingRequests.requestId, first.requestId));
    const second = await ask(worker, permission("pwd"), { inputHash: HASH_B });
    expect(await stream(sessionId)).toEqual([
      `question:${first.requestId}`,
      "status:needs_input",
      "status:running",
      `question:${second.requestId}`,
      "status:needs_input",
    ]);
  });

  test("an interrupt or a terminate that closes the requests reports the end of the wait", async () => {
    const interrupted = await runningSession();
    const asked = await ask(interrupted.worker, permission());
    const accepted = await createPostgresTurnInterrupts(db).interruptAtomic({
      principal: interrupted.owner,
      sessionId: interrupted.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      targetTurnId: "1",
    });
    expect(accepted.outcome).toBe("accepted");
    expect(await stream(interrupted.sessionId)).toEqual([
      `question:${asked.requestId}`,
      "status:needs_input",
      "status:running",
    ]);

    const terminated = await runningSession();
    const pending = await ask(terminated.worker, permission());
    const [row] = await db
      .select({ revision: sessions.revision })
      .from(sessions)
      .where(eq(sessions.id, terminated.sessionId));
    const stopped = await createPostgresSessionControl(db).terminateAtomic({
      principal: terminated.owner,
      sessionId: terminated.sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row?.revision ?? 0,
      reason: null,
      now: new Date(),
    });
    expect(stopped.outcome).toBe("accepted");
    const detail = await createPostgresSessionReader(db).getSession(
      terminated.owner.ownerId,
      terminated.sessionId,
    );
    expect(await stream(terminated.sessionId)).toEqual([
      `question:${pending.requestId}`,
      "status:needs_input",
      `status:${detail?.status}`,
    ]);
  });

  test("a pause reports the status the session reads, needs_input included", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await ask(worker, permission());
    const [row] = await db
      .select({ revision: sessions.revision })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const paused = await createPostgresSessionControl(db).pauseAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: row?.revision ?? 0,
      reason: "overnight",
      now: new Date(),
    });
    expect(paused.outcome).toBe("accepted");
    const detail = await createPostgresSessionReader(db).getSession(
      owner.ownerId,
      sessionId,
    );
    // The worker drains on its own lease, so its question still stands.
    expect(detail?.status).toBe("needs_input");
    expect(await stream(sessionId)).toEqual([
      `question:${requestId}`,
      "status:needs_input",
      "status:needs_input",
    ]);
    expect(await announced(sessionId)).toBe(true);

    // A resume that cancels the pause leaves the drainer and its question.
    const [pausing] = await db
      .select({ revision: sessions.revision })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const resumed = await createPostgresSessionControl(db).resumeAtomic({
      principal: owner,
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: pausing?.revision ?? 0,
      now: new Date(),
    });
    expect(resumed.outcome).toBe("accepted");
    expect((await stream(sessionId)).at(-1)).toBe("status:needs_input");
    expect(await announced(sessionId)).toBe(true);
  });

  test("a worker that publishes its own question gets no events from the gateway", async () => {
    const { owner, sessionId, worker } = await runningSession();
    const { requestId } = await register(worker, permission());
    expect(await stream(sessionId)).toEqual([]);
    await answer(owner, sessionId, {
      request_id: requestId,
      kind: "permission",
      decision: "allow",
    });
    expect(await stream(sessionId)).toEqual([]);
    expect(await announced(sessionId)).toBe(false);
  });
});
