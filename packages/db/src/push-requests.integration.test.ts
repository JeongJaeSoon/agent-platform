import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@agent-platform/contracts";
import type {
  DecidePushRequestInput,
  PushRequestStore,
  PushWriteResult,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import { pushRequests, receipts, sessions } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-push";
const COMMIT = "b".repeat(40);
const REQUESTER: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};
const APPROVER: ReceiptActor = {
  principal: { kind: "user", id: "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35" },
  actor_user_id: "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
  agent_id: null,
};

function written(result: PushWriteResult) {
  if (result.outcome !== "written" && result.outcome !== "replayed") {
    throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  }
  return result.request;
}

integration("postgres push requests", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: PushRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "push_requests_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    store = createPostgresPushRequests(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function session(checkpointRevision: number | null = 2) {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: OWNER,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      repositoryId: "sample-app",
      checkpointRevision,
    });
    return id;
  }

  const create = (sessionId: string, key = "k-create", revision = 2) =>
    store.create({
      ownerId: OWNER,
      sessionId,
      actor: REQUESTER,
      idempotencyKey: key,
      payloadHash: "h-create",
      repositoryId: "sample-app",
      checkpointRevision: revision,
      gitCommit: COMMIT,
    });

  const decide = (
    sessionId: string,
    pushRequestId: string,
    overrides: Partial<DecidePushRequestInput> = {},
  ) =>
    store.decide({
      ownerId: OWNER,
      sessionId,
      pushRequestId,
      actor: APPROVER,
      decision: "approve",
      gitCommit: COMMIT,
      reason: null,
      idempotencyKey: "k-decide",
      payloadHash: "h-decide",
      ...overrides,
    });

  async function receipt(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    if (!row) throw new Error(`no receipt ${id}`);
    return row;
  }

  test("create pins the commit and the platform's branch, with a receipt", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    expect(request).toMatchObject({
      session_id: sessionId,
      repository_id: "sample-app",
      checkpoint_revision: 2,
      git_commit: COMMIT,
      target_branch: `agent/${sessionId}`,
      state: "requested",
      requested_by: REQUESTER,
      decided_by: null,
    });
    const row = await receipt(request.request_receipt_id);
    expect(row).toMatchObject({
      ownerId: OWNER,
      operation: "request_push",
      status: "succeeded",
      actor: REQUESTER,
      targetRef: {
        session_id: sessionId,
        turn_id: null,
        request_id: request.id,
      },
      result: {
        push_request_id: request.id,
        verdict: "allow",
        refusal: null,
        checkpoint_revision: 2,
        git_commit: COMMIT,
        target_branch: `agent/${sessionId}`,
      },
    });
    expect(written(await create(sessionId)).id).toBe(request.id);
    const second = await create(sessionId, "k-other");
    expect(second).toMatchObject({
      outcome: "refused",
      refusal: "request_open",
    });
    if (second.outcome !== "refused") throw new Error("unreachable");
    expect(await receipt(second.receiptId)).toMatchObject({
      operation: "request_push",
      status: "failed",
      error: { code: "PUSH_REQUEST_OPEN" },
      result: { verdict: "refuse", push_request_id: request.id },
    });
    expect(await store.list(OWNER, sessionId)).toHaveLength(1);
    expect(await store.list("someone-else", sessionId)).toBeNull();
    expect(await store.get("someone-else", sessionId, request.id)).toBeNull();
  });

  test("concurrent creates on one session open one request", async () => {
    const sessionId = await session();
    const results = await Promise.all(
      ["k-race-1", "k-race-2", "k-race-3"].map((key) => create(sessionId, key)),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "refused",
      "refused",
      "written",
    ]);
    for (const result of results) {
      if (result.outcome === "refused") {
        expect(result.refusal).toBe("request_open");
      }
    }
    expect(await store.list(OWNER, sessionId)).toHaveLength(1);
  });

  test("create refuses a pointer that moved after the caller read it", async () => {
    const sessionId = await session(3);
    expect(await create(sessionId, "k-moved", 2)).toMatchObject({
      outcome: "refused",
      refusal: "checkpoint_moved",
    });
    expect(await store.list(OWNER, sessionId)).toEqual([]);
  });

  test("approve once; a second decision is refused and recorded", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    const approved = written(
      await decide(sessionId, request.id, { reason: "reviewed" }),
    );
    expect(approved).toMatchObject({
      state: "approved",
      decided_by: APPROVER,
      decision_reason: "reviewed",
    });
    expect(approved.decided_at).not.toBeNull();
    expect(await receipt(approved.decision_receipt_id ?? "")).toMatchObject({
      operation: "decide_push",
      status: "succeeded",
      actor: APPROVER,
      result: {
        decision: "approve",
        verdict: "allow",
        git_commit: COMMIT,
        checkpoint_revision: 2,
      },
    });
    expect(
      written(await decide(sessionId, request.id)).decision_receipt_id,
    ).toBe(approved.decision_receipt_id);
    expect(
      await decide(sessionId, request.id, { payloadHash: "other" }),
    ).toEqual({ outcome: "conflict" });
    const again = await decide(sessionId, request.id, {
      decision: "reject",
      idempotencyKey: "k-again",
    });
    expect(again).toMatchObject({
      outcome: "refused",
      refusal: "already_decided",
    });
    if (again.outcome !== "refused") throw new Error("unreachable");
    expect(await receipt(again.receiptId)).toMatchObject({
      status: "failed",
      error: { code: "PUSH_REQUEST_DECIDED" },
      result: { decision: "reject", verdict: "refuse", git_commit: COMMIT },
    });
    expect((await store.get(OWNER, sessionId, request.id))?.state).toBe(
      "approved",
    );
  });

  test("an approval of another commit, or after the session checkpointed again, is refused", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    expect(
      await decide(sessionId, request.id, { gitCommit: "c".repeat(40) }),
    ).toMatchObject({ outcome: "refused", refusal: "commit_mismatch" });
    await db
      .update(sessions)
      .set({ checkpointRevision: 3 })
      .where(eq(sessions.id, sessionId));
    const moved = await decide(sessionId, request.id, {
      idempotencyKey: "k-moved",
    });
    expect(moved).toMatchObject({
      outcome: "refused",
      refusal: "checkpoint_moved",
    });
    if (moved.outcome !== "refused") throw new Error("unreachable");
    expect(await receipt(moved.receiptId)).toMatchObject({
      error: { code: "CHECKPOINT_MOVED" },
      result: { checkpoint_revision: 2, verdict: "refuse" },
    });
    expect((await store.get(OWNER, sessionId, request.id))?.state).toBe(
      "requested",
    );
    const rejected = written(
      await decide(sessionId, request.id, {
        decision: "reject",
        idempotencyKey: "k-reject",
      }),
    );
    expect(rejected.state).toBe("rejected");
    expect(
      written(await create(sessionId, "k-new", 3)).checkpoint_revision,
    ).toBe(3);
  });

  test("a replay answers only on the session it was made on", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId, "k-replay"));
    expect(
      await store.replayCreate({
        ownerId: OWNER,
        sessionId,
        idempotencyKey: "k-replay",
        payloadHash: "h-create",
      }),
    ).toMatchObject({ outcome: "replayed", request: { id: request.id } });
    expect(
      await store.replayCreate({
        ownerId: OWNER,
        sessionId,
        idempotencyKey: "k-unused",
        payloadHash: "h-create",
      }),
    ).toBeNull();
    written(await decide(sessionId, request.id, { idempotencyKey: "k-dr" }));
    const elsewhere = await session();
    expect(
      await decide(elsewhere, request.id, { idempotencyKey: "k-dr" }),
    ).toMatchObject({ outcome: "refused", refusal: "not_found" });
  });

  test("decisions on an unknown request or another owner's session are refused", async () => {
    const sessionId = await session();
    expect(
      await decide(sessionId, crypto.randomUUID(), { idempotencyKey: "k-x" }),
    ).toMatchObject({ outcome: "refused", refusal: "not_found" });
    const request = written(await create(sessionId));
    expect(
      await decide(sessionId, request.id, {
        ownerId: "someone-else",
        idempotencyKey: "k-y",
      }),
    ).toMatchObject({ outcome: "refused", refusal: "not_found" });
  });

  test("the pusher claims each approved request once and records the outcome", async () => {
    const pushed = await session();
    const failed = await session();
    for (const sessionId of [pushed, failed]) {
      const request = written(await create(sessionId));
      written(await decide(sessionId, request.id));
    }
    const claimed = new Set<string>();
    for (;;) {
      const job = await store.claimNextApproved();
      if (job === null) break;
      claimed.add(job.sessionId);
      expect(job).toMatchObject({
        gitCommit: COMMIT,
        targetBranch: `agent/${job.sessionId}`,
        checkpointRevision: 2,
      });
      expect(
        await store.finish(
          job.id,
          job.sessionId === pushed
            ? { state: "pushed" }
            : {
                state: "failed",
                error: { code: "INTERNAL_ERROR", message: "remote refused" },
              },
        ),
      ).toBe(true);
      expect(await store.finish(job.id, { state: "pushed" })).toBe(false);
    }
    expect(claimed).toContain(pushed);
    expect(claimed).toContain(failed);
    const [done] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.sessionId, failed));
    expect(done).toMatchObject({
      state: "failed",
      pushError: { code: "INTERNAL_ERROR", message: "remote refused" },
    });
    expect(await receipt(done?.pushReceiptId ?? "")).toMatchObject({
      operation: "push",
      status: "failed",
    });
  });

  test("the table refuses a branch other than agent/<session-id> and an undecided approval", async () => {
    const sessionId = await session();
    const request = written(await create(sessionId));
    const update = async (set: Partial<typeof pushRequests.$inferInsert>) => {
      await db
        .update(pushRequests)
        .set(set)
        .where(eq(pushRequests.id, request.id));
    };
    await expect(update({ targetBranch: "main" })).rejects.toThrow();
    await expect(update({ state: "approved" })).rejects.toThrow();
  });
});
