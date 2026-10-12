import { randomUUID } from "node:crypto";
import {
  OPEN_PUSH_REQUEST_STATES,
  type PushReceiptResult,
  type PushRequest,
  type PushRequestState,
  pushBranchFor,
  type ReceiptActor,
} from "@agent-platform/contracts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushJob,
  type PushRefusalRecord,
  type PushRequestStore,
  type PushWriteResult,
} from "@agent-platform/platform";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { findIdempotent, lockIdempotencyScope } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import { idempotencyKeys, pushRequests, receipts, sessions } from "./schema.ts";

type Row = typeof pushRequests.$inferSelect;

function publicPushRequest(row: Row): PushRequest {
  return {
    id: row.id,
    session_id: row.sessionId,
    repository_id: row.repositoryId,
    checkpoint_revision: row.checkpointRevision,
    git_commit: row.gitCommit,
    target_branch: row.targetBranch,
    state: row.state as PushRequestState,
    requested_by: row.requestedBy as ReceiptActor,
    requested_at: row.createdAt.toISOString(),
    decided_by: (row.decidedBy as ReceiptActor | null) ?? null,
    decided_at: row.decidedAt?.toISOString() ?? null,
    decision_reason: row.decisionReason,
    request_receipt_id: row.requestReceiptId,
    decision_receipt_id: row.decisionReceiptId,
  };
}

function resultOf(
  row: Row | null,
  fields: Pick<PushReceiptResult, "decision" | "verdict" | "refusal">,
): PushReceiptResult {
  return {
    push_request_id: row?.id ?? null,
    ...fields,
    repository_id: row?.repositoryId ?? null,
    checkpoint_revision: row?.checkpointRevision ?? null,
    git_commit: row?.gitCommit ?? null,
    target_branch: row?.targetBranch ?? null,
  };
}

async function insertRefusal(
  tx: Database,
  input: PushRefusalRecord,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: input.ownerId,
    operation: input.operation,
    targetRef: {
      session_id: input.sessionId,
      turn_id: null,
      request_id: input.result.push_request_id,
    },
    status: "failed",
    result: input.result,
    error: PUSH_REFUSAL_ERRORS[input.refusal],
    actor: input.actor,
  });
  return id;
}

export function createPostgresPushRequests(db: Database): PushRequestStore {
  return {
    async findSession(ownerId, sessionId) {
      const [row] = await db
        .select({ repositoryId: sessions.repositoryId })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, ownerId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    recordRefusal(input) {
      return insertRefusal(db, input);
    },

    create(input): Promise<PushWriteResult> {
      const sessionId = input.sessionId.toLowerCase();
      const scope = {
        principal: input.ownerId,
        operation: "request_push",
        resource: sessionId,
        key: input.idempotencyKey,
      };
      const refuse = async (
        tx: Database,
        refusal: "not_found" | "request_open" | "checkpoint_moved",
        row: Row | null,
      ): Promise<PushWriteResult> => ({
        outcome: "refused",
        refusal,
        receiptId: await insertRefusal(tx, {
          ownerId: input.ownerId,
          sessionId,
          actor: input.actor,
          operation: "request_push",
          refusal,
          result: resultOf(row, {
            decision: null,
            verdict: "refuse",
            refusal,
          }),
        }),
      });
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          const [row] = await tx
            .select()
            .from(pushRequests)
            .where(eq(pushRequests.requestReceiptId, existing.receiptId))
            .limit(1);
          if (row)
            return { outcome: "replayed", request: publicPushRequest(row) };
        }
        // Serializes creates per session, so the open-request check below
        // and the partial unique index never race.
        const [session] = await tx
          .select({ checkpointRevision: sessions.checkpointRevision })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return refuse(tx, "not_found", null);
        const [open] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.sessionId, sessionId),
              inArray(pushRequests.state, [...OPEN_PUSH_REQUEST_STATES]),
            ),
          )
          .limit(1);
        if (open) return refuse(tx, "request_open", open);
        if (session.checkpointRevision !== input.checkpointRevision) {
          return refuse(tx, "checkpoint_moved", null);
        }
        const id = randomUUID();
        const receiptId = randomUUID();
        const targetBranch = pushBranchFor(sessionId);
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.ownerId,
          operation: "request_push",
          targetRef: { session_id: sessionId, turn_id: null, request_id: id },
          status: "succeeded",
          result: {
            push_request_id: id,
            decision: null,
            verdict: "allow",
            refusal: null,
            repository_id: input.repositoryId,
            checkpoint_revision: input.checkpointRevision,
            git_commit: input.gitCommit,
            target_branch: targetBranch,
          } satisfies PushReceiptResult,
          actor: input.actor,
        });
        await tx.insert(idempotencyKeys).values({
          ...scope,
          payloadHash: input.payloadHash,
          receiptId,
        });
        const [row] = await tx
          .insert(pushRequests)
          .values({
            id,
            ownerId: input.ownerId,
            sessionId,
            repositoryId: input.repositoryId,
            checkpointRevision: input.checkpointRevision,
            gitCommit: input.gitCommit,
            targetBranch,
            requestedBy: input.actor,
            requestReceiptId: receiptId,
          })
          .returning();
        if (!row) throw new Error("push request insert returned no row");
        return { outcome: "written", request: publicPushRequest(row) };
      });
    },

    async list(ownerId, sessionId) {
      const session = await this.findSession(ownerId, sessionId);
      if (!session) return null;
      const rows = await db
        .select()
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .orderBy(desc(pushRequests.createdAt), desc(pushRequests.id));
      return rows.map(publicPushRequest);
    },

    async get(ownerId, sessionId, pushRequestId) {
      const [row] = await db
        .select()
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.id, pushRequestId.toLowerCase()),
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .limit(1);
      return row ? publicPushRequest(row) : null;
    },

    decide(input): Promise<PushWriteResult> {
      const sessionId = input.sessionId.toLowerCase();
      const pushRequestId = input.pushRequestId.toLowerCase();
      const scope = {
        principal: input.ownerId,
        operation: "decide_push",
        resource: pushRequestId,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        const refuse = async (
          refusal:
            | "not_found"
            | "already_decided"
            | "checkpoint_moved"
            | "commit_mismatch",
          row: Row | null,
        ): Promise<PushWriteResult> => ({
          outcome: "refused",
          refusal,
          receiptId: await insertRefusal(tx, {
            ownerId: input.ownerId,
            sessionId,
            actor: input.actor,
            operation: "decide_push",
            refusal,
            result: resultOf(row, {
              decision: input.decision,
              verdict: "refuse",
              refusal,
            }),
          }),
        });
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          const [row] = await tx
            .select()
            .from(pushRequests)
            .where(eq(pushRequests.decisionReceiptId, existing.receiptId))
            .limit(1);
          if (row)
            return { outcome: "replayed", request: publicPushRequest(row) };
        }
        // FOR SHARE holds the checkpoint pointer still until the decision
        // commits, so an approval can never land on a moved pointer.
        const [session] = await tx
          .select({ checkpointRevision: sessions.checkpointRevision })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("share");
        if (!session) return refuse("not_found", null);
        const [row] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, pushRequestId),
              eq(pushRequests.sessionId, sessionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) return refuse("not_found", null);
        if (row.state !== "requested") return refuse("already_decided", row);
        if (input.decision === "approve") {
          if (input.gitCommit !== row.gitCommit) {
            return refuse("commit_mismatch", row);
          }
          if (session.checkpointRevision !== row.checkpointRevision) {
            return refuse("checkpoint_moved", row);
          }
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.ownerId,
          operation: "decide_push",
          targetRef: {
            session_id: sessionId,
            turn_id: null,
            request_id: row.id,
          },
          status: "succeeded",
          result: resultOf(row, {
            decision: input.decision,
            verdict: "allow",
            refusal: null,
          }),
          actor: input.actor,
        });
        await tx.insert(idempotencyKeys).values({
          ...scope,
          payloadHash: input.payloadHash,
          receiptId,
        });
        const [decided] = await tx
          .update(pushRequests)
          .set({
            state: input.decision === "approve" ? "approved" : "rejected",
            decidedBy: input.actor,
            decidedAt: sql`now()`,
            decisionReason: input.reason,
            decisionReceiptId: receiptId,
          })
          .where(eq(pushRequests.id, row.id))
          .returning();
        if (!decided) throw new Error("push request update returned no row");
        return { outcome: "written", request: publicPushRequest(decided) };
      });
    },

    async claimNextApproved(): Promise<PushJob | null> {
      const [row] = await db
        .update(pushRequests)
        .set({ state: "pushing", pushStartedAt: sql`now()` })
        .where(
          eq(
            pushRequests.id,
            sql`(SELECT ${pushRequests.id} FROM ${pushRequests} WHERE ${pushRequests.state} = 'approved' ORDER BY ${pushRequests.createdAt} LIMIT 1 FOR UPDATE SKIP LOCKED)`,
          ),
        )
        .returning();
      if (!row) return null;
      return {
        id: row.id,
        ownerId: row.ownerId,
        sessionId: row.sessionId,
        repositoryId: row.repositoryId,
        checkpointRevision: row.checkpointRevision,
        gitCommit: row.gitCommit,
        targetBranch: row.targetBranch,
      };
    },

    finish(pushRequestId, outcome) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, pushRequestId),
              eq(pushRequests.state, "pushing"),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) return false;
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: row.ownerId,
          operation: "push",
          targetRef: {
            session_id: row.sessionId,
            turn_id: null,
            request_id: row.id,
          },
          status: outcome.state === "pushed" ? "succeeded" : "failed",
          result: resultOf(row, {
            decision: null,
            verdict: outcome.state === "pushed" ? "allow" : "refuse",
            refusal: null,
          }),
          error: outcome.state === "failed" ? outcome.error : null,
        });
        await tx
          .update(pushRequests)
          .set({
            state: outcome.state,
            finishedAt: sql`now()`,
            pushError: outcome.state === "failed" ? outcome.error : null,
            pushReceiptId: receiptId,
          })
          .where(eq(pushRequests.id, row.id));
        return true;
      });
    },
  };
}
