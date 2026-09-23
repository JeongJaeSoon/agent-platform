import { postSessionAnswerRequestSchema } from "@agent-platform/contracts";
import type {
  PendingControlInput,
  PendingControlResult,
  RegisterPendingInput,
  RegisterPendingResult,
  WorkerFence,
  WorkerPendingStore,
} from "@agent-platform/platform";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { pendingRequests, receipts, turns } from "./schema.ts";
import { acquireFence, leaseHeld, parseTurnId } from "./worker-unit-of-work.ts";

const OPEN_TURN_STATUSES = ["running", "needs_input"];

// What the worker's word does to the answer's receipt. `answered` means the
// callback got it, whatever it decided; the other two mean the answer was
// dropped, so the person who gave it learns it did nothing.
const RECEIPT_BY_OUTCOME = {
  answered: { status: "succeeded" as const, error: null },
  expired: {
    status: "failed" as const,
    error: {
      code: "REQUEST_EXPIRED",
      message:
        "the request timed out on the worker before the answer reached it",
    },
  },
  cancelled: {
    status: "failed" as const,
    error: {
      code: "REQUEST_STALE",
      message: "the request's callback was gone before the answer reached it",
    },
  },
};

function undelivered(fence: WorkerFence) {
  return and(
    eq(pendingRequests.sessionId, fence.sessionId),
    eq(pendingRequests.attemptId, fence.attemptId),
    isNotNull(pendingRequests.answeredAt),
    isNull(pendingRequests.settledAt),
  );
}

export function createPostgresWorkerPendingStore(
  db: Database,
): WorkerPendingStore {
  return {
    registerAtomic(
      input: RegisterPendingInput,
    ): Promise<RegisterPendingResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const sequence = parseTurnId(input.turnId);
        // Only the turn this attempt is running: a callback belongs to the
        // turn that raised it, and a closed turn has no callback left.
        const [turn] = sequence
          ? await tx
              .select({ id: turns.id, status: turns.status })
              .from(turns)
              .where(
                and(
                  eq(turns.sessionId, fence.sessionId),
                  eq(turns.sequence, sequence),
                  eq(turns.attemptId, fence.attemptId),
                ),
              )
              .limit(1)
          : [];
        if (!turn || !OPEN_TURN_STATUSES.includes(turn.status)) {
          return { outcome: "turn_not_found" };
        }

        const [existing] = await tx
          .select()
          .from(pendingRequests)
          .where(eq(pendingRequests.requestId, input.requestId))
          .limit(1)
          .for("update");
        const at = await dbNow(tx);
        if (existing) {
          // A retry of a registration whose response was lost. It stays the
          // same registration — same expiry, answered or not — until the
          // worker settles it; after that the id is spent.
          const same =
            existing.sessionId === fence.sessionId &&
            existing.attemptId === fence.attemptId &&
            existing.turnId === turn.id &&
            existing.kind === input.request.kind &&
            existing.inputHash === input.inputHash &&
            existing.settledAt === null;
          if (!same) return { outcome: "conflict" };
          return {
            outcome: "replayed",
            expiresAt: existing.expiresAt,
            expiresInMs: Math.max(
              0,
              existing.expiresAt.getTime() - at.getTime(),
            ),
          };
        }
        if (!leaseHeld(fenced.attempt, at)) return { outcome: "lease_expired" };
        const expiresAt = new Date(at.getTime() + input.ttlMs);
        await tx.insert(pendingRequests).values({
          requestId: input.requestId,
          sessionId: fence.sessionId,
          turnId: turn.id,
          attemptId: fence.attemptId,
          kind: input.request.kind,
          payload: input.request,
          inputHash: input.inputHash,
          expiresAt,
          createdAt: at,
        });
        return {
          outcome: "registered",
          expiresAt,
          expiresInMs: input.ttlMs,
        };
      });
    },

    pendingControlAtomic(
      input: PendingControlInput,
    ): Promise<PendingControlResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        if (input.settled.length > 0) {
          const at = await dbNow(tx);
          if (!leaseHeld(fenced.attempt, at)) {
            return { outcome: "lease_expired" };
          }
          const rows = await tx
            .select()
            .from(pendingRequests)
            .where(
              and(
                eq(pendingRequests.sessionId, fence.sessionId),
                eq(pendingRequests.attemptId, fence.attemptId),
                inArray(
                  pendingRequests.requestId,
                  input.settled.map((item) => item.request_id),
                ),
              ),
            )
            .orderBy(asc(pendingRequests.requestId))
            .for("update");
          const byId = new Map(rows.map((row) => [row.requestId, row]));
          for (const settlement of input.settled) {
            const row = byId.get(settlement.request_id);
            // Unknown or already settled: the first word stands, and a
            // repeat of it is what a retried poll looks like.
            if (!row || row.settledAt !== null) continue;
            // Nothing was delivered, so there is nothing to have answered.
            if (settlement.outcome === "answered" && row.answeredAt === null) {
              continue;
            }
            await tx
              .update(pendingRequests)
              .set({
                settledAt: at,
                settledOutcome: settlement.outcome,
                resolvedAt: row.resolvedAt ?? at,
              })
              .where(eq(pendingRequests.requestId, row.requestId));
            row.settledAt = at;
            if (row.answerReceiptId !== null) {
              const effect = RECEIPT_BY_OUTCOME[settlement.outcome];
              await tx
                .update(receipts)
                .set({ ...effect, updatedAt: at })
                .where(
                  and(
                    eq(receipts.id, row.answerReceiptId),
                    eq(receipts.status, "accepted"),
                  ),
                );
            }
          }
        }
        const rows = await tx
          .select({
            sequence: pendingRequests.answerSequence,
            answer: pendingRequests.answer,
            inputHash: pendingRequests.inputHash,
          })
          .from(pendingRequests)
          .where(
            and(
              undelivered(fence),
              gt(pendingRequests.answerSequence, input.answersAfter),
            ),
          )
          .orderBy(asc(pendingRequests.answerSequence));
        // The reads above can wait on locks; an answer handed over after the
        // lease ended would let the engine act for an owner that is gone.
        if (!leaseHeld(fenced.attempt, await dbNow(tx))) {
          return { outcome: "lease_expired" };
        }
        return {
          outcome: "ok",
          answers: rows.map((row) => ({
            sequence: row.sequence as number,
            answer: postSessionAnswerRequestSchema.parse(row.answer),
            inputHash: row.inputHash,
          })),
        };
      });
    },

    async hasUndelivered(fence: WorkerFence): Promise<boolean> {
      const [row] = await db
        .select({ one: sql<number>`1` })
        .from(pendingRequests)
        .where(undelivered(fence))
        .limit(1);
      return row !== undefined;
    },
  };
}
