import { randomUUID } from "node:crypto";
import {
  type PendingQuestion,
  type PendingRequest,
  pendingQuestionSchema,
  questionAnswerMismatch,
} from "@agent-platform/contracts";
import type {
  AnswerRequestInput,
  AnswerRequestResult,
  PendingRequestStore,
} from "@agent-platform/platform";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  notInArray,
  sql,
} from "drizzle-orm";
import { DB_NOW, dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  attempts,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  turns,
} from "./schema.ts";

const ANSWER = "answer";
const ENDED_ATTEMPT_STATES = ["exited", "lost"];
const OPEN_TURN_STATUSES = ["running", "needs_input"];

type StoredPayload =
  | { kind: "permission"; tool: string; input: NonNullable<unknown> | null }
  | { kind: "question"; questions: PendingQuestion[] };

/**
 * The attempt that asked still owns the session and is still inside the
 * turn it asked in. Anything less and its callback is gone, whatever the
 * row says: an epoch or auth rotation, an ended attempt, a lapsed lease or
 * a closed turn each mean nobody is left to hand an answer to.
 */
function askerIsLive(at: Date | typeof DB_NOW) {
  return and(
    eq(attempts.leaseEpoch, sessions.leaseEpoch),
    eq(attempts.executionGeneration, sessions.executionGeneration),
    eq(attempts.authRevision, sessions.authRevision),
    notInArray(attempts.state, ENDED_ATTEMPT_STATES),
    gt(attempts.leaseExpiresAt, at),
    inArray(turns.status, OPEN_TURN_STATUSES),
    eq(turns.attemptId, pendingRequests.attemptId),
  );
}

// One instant for a whole statement: a status and a count read in the same
// SELECT must not straddle an expiry or a lease end.
const STATEMENT_NOW = sql<Date>`statement_timestamp()`;

function actionable(at: typeof DB_NOW) {
  return and(
    isNull(pendingRequests.resolvedAt),
    gt(pendingRequests.expiresAt, at),
    askerIsLive(at),
  );
}

/**
 * What a client can still act on: open, unexpired and asked by a live
 * attempt. `pending_request_count` counts the same rows, so the summary and
 * the list never disagree.
 */
export function actionablePendingWhere(sessionId: string) {
  return and(eq(pendingRequests.sessionId, sessionId), actionable(DB_NOW));
}

/**
 * The actionable requests of the outer query's `sessions` row, which
 * `askerIsLive` compares their attempt against. Read beside that row, in the
 * same statement, so its status and its count come from one snapshot.
 */
export function actionableOfSession(db: Database) {
  return db
    .select({ one: sql`1` })
    .from(pendingRequests)
    .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
    .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
    .where(
      and(
        eq(pendingRequests.sessionId, sessions.id),
        actionable(STATEMENT_NOW),
      ),
    );
}

// The same, for the outer query's `turns` row.
export function actionableOfTurn(db: Database) {
  return db
    .select({ one: sql`1` })
    .from(pendingRequests)
    .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
    .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
    .where(
      and(
        // Redundant with turn_id, but it is what the unresolved-by-session
        // index is keyed on.
        eq(pendingRequests.sessionId, turns.sessionId),
        eq(pendingRequests.turnId, turns.id),
        actionable(STATEMENT_NOW),
      ),
    );
}

/**
 * `needs_input` is never stored (DESIGN.md §6.4): it is a running session or
 * turn with a request a person can still answer. Derived on read, it drops
 * back the instant the last one is answered, settled, expires or loses its
 * attempt, with no write or sweep to miss.
 */
export function publicStatus<S extends string>(
  stored: S,
  awaitingInput: boolean,
): S | "needs_input" {
  return stored === "running" && awaitingInput ? "needs_input" : stored;
}

/**
 * The execution is gone, so answers it was handed but never acknowledged
 * may or may not have reached their callbacks. Their receipts say unknown,
 * not failed: an approval could have been acted on before the worker died.
 * The rows are closed for good either way.
 */
export async function abandonUndeliveredAnswers(
  tx: Database,
  sessionId: string,
  now: Date,
) {
  const abandoned = await tx
    .update(pendingRequests)
    .set({ settledAt: now, settledOutcome: "lost" })
    .where(
      and(
        eq(pendingRequests.sessionId, sessionId),
        isNotNull(pendingRequests.answeredAt),
        isNull(pendingRequests.settledAt),
      ),
    )
    .returning({ receiptId: pendingRequests.answerReceiptId });
  const receiptIds = abandoned.flatMap((row) =>
    row.receiptId === null ? [] : [row.receiptId],
  );
  if (receiptIds.length === 0) return;
  await tx
    .update(receipts)
    .set({
      status: "unknown",
      error: {
        code: "REQUEST_STALE",
        message:
          "the execution ended before confirming the answer reached its request",
      },
      updatedAt: now,
    })
    .where(
      and(inArray(receipts.id, receiptIds), eq(receipts.status, "accepted")),
    );
}

export function publicPendingRequest(row: {
  requestId: string;
  turnSequence: number;
  attemptId: string;
  payload: unknown;
  createdAt: Date;
  expiresAt: Date;
}): PendingRequest {
  const payload = row.payload as StoredPayload;
  const base = {
    request_id: row.requestId,
    turn_id: String(row.turnSequence),
    attempt_id: row.attemptId,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
  };
  return payload.kind === "permission"
    ? { ...base, kind: "permission", tool: payload.tool, input: payload.input }
    : { ...base, kind: "question", questions: payload.questions };
}

// Same discipline as the other commands: the advisory lock goes first so a
// same-key race is settled before any row lock is taken.
async function lockIdempotencyScope(
  tx: Database,
  scope: { principal: string; resource: string; key: string },
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([scope.principal, ANSWER, scope.resource, scope.key])}))`,
  );
}

function answerMismatch(
  payload: StoredPayload,
  answer: AnswerRequestInput["answer"],
): string | null {
  if (payload.kind !== answer.kind) {
    return `A ${answer.kind} answer cannot settle a ${payload.kind} request`;
  }
  if (answer.kind === "permission") return null;
  const questions = pendingQuestionSchema
    .array()
    .parse((payload as { questions: unknown }).questions);
  return questionAnswerMismatch(questions, answer.answers);
}

export function createPostgresPendingRequests(
  db: Database,
): PendingRequestStore {
  return {
    async listOpen(ownerId, sessionId) {
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
        .limit(1);
      if (!session) return null;
      const rows = await db
        .select({
          requestId: pendingRequests.requestId,
          turnSequence: turns.sequence,
          attemptId: pendingRequests.attemptId,
          payload: pendingRequests.payload,
          createdAt: pendingRequests.createdAt,
          expiresAt: pendingRequests.expiresAt,
        })
        .from(pendingRequests)
        .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
        .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
        .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
        .where(actionablePendingWhere(sessionId))
        .orderBy(
          asc(pendingRequests.createdAt),
          asc(pendingRequests.requestId),
        );
      return rows.map(publicPendingRequest);
    },

    answerAtomic(input: AnswerRequestInput): Promise<AnswerRequestResult> {
      const sessionId = input.sessionId.toLowerCase();
      const scope = {
        principal: input.principal.ownerId,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const [existing] = await tx
          .select({
            payloadHash: idempotencyKeys.payloadHash,
            receiptId: receipts.id,
            status: receipts.status,
          })
          .from(idempotencyKeys)
          .innerJoin(receipts, eq(receipts.id, idempotencyKeys.receiptId))
          .where(
            and(
              eq(idempotencyKeys.principal, scope.principal),
              eq(idempotencyKeys.operation, ANSWER),
              eq(idempotencyKeys.resource, scope.resource),
              eq(idempotencyKeys.key, scope.key),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          // The receipt's current status: by now the worker may have
          // settled what the first call only stored.
          return {
            outcome: "replayed",
            response: {
              receipt_id: existing.receiptId,
              receipt_status: existing.status,
            },
          };
        }

        // Session before pending row, the order the gateway paths take.
        const [session] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" };
        const [pending] = await tx
          .select()
          .from(pendingRequests)
          .where(
            and(
              eq(pendingRequests.requestId, input.answer.request_id),
              eq(pendingRequests.sessionId, sessionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!pending) return { outcome: "not_found" };
        if (pending.answeredAt !== null) return { outcome: "expired" };

        const [last] = await tx
          .select({ sequence: max(pendingRequests.answerSequence) })
          .from(pendingRequests)
          .where(eq(pendingRequests.sessionId, sessionId));
        const sequence = (last?.sequence ?? 0) + 1;
        // Read last before the writes: a lease or TTL judged on an earlier
        // reading could lapse under the remaining reads and accept an
        // answer nobody can take.
        const at = await dbNow(tx);
        // The session row is locked, so nothing can move the epoch, the
        // lease or the turn while this reads them.
        const [asker] = await tx
          .select({ attemptId: attempts.id, turnSequence: turns.sequence })
          .from(pendingRequests)
          .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
          .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
          .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
          .where(
            and(
              eq(pendingRequests.requestId, pending.requestId),
              askerIsLive(at),
            ),
          )
          .limit(1);
        if (!asker) return { outcome: "stale" };
        if (pending.resolvedAt !== null) return { outcome: "expired" };
        if (pending.expiresAt.getTime() <= at.getTime()) {
          return { outcome: "expired" };
        }
        const mismatch = answerMismatch(
          pending.payload as StoredPayload,
          input.answer,
        );
        if (mismatch !== null) return { outcome: "invalid", reason: mismatch };

        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: scope.principal,
          operation: ANSWER,
          targetRef: {
            session_id: sessionId,
            turn_id: String(asker.turnSequence),
            request_id: pending.requestId,
          },
          status: "accepted",
          result: null,
          createdAt: at,
          updatedAt: at,
        });
        await tx.insert(idempotencyKeys).values({
          principal: scope.principal,
          operation: ANSWER,
          resource: scope.resource,
          key: scope.key,
          payloadHash: input.payloadHash,
          receiptId,
        });
        await tx
          .update(pendingRequests)
          .set({
            answer: input.answer,
            answeredAt: at,
            resolvedAt: at,
            answerSequence: sequence,
            answerReceiptId: receiptId,
          })
          .where(eq(pendingRequests.requestId, pending.requestId));
        return {
          outcome: "accepted",
          response: { receipt_id: receiptId, receipt_status: "accepted" },
        };
      });
    },
  };
}
