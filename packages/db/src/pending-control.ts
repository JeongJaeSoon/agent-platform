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
import { openPauseReceipt } from "./pause-control.ts";
import { awaitingInputAt, publicStatus } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { pendingRequests, receipts, sessions, turns } from "./schema.ts";
import {
  announceInputWaitEnded,
  inputWaitBefore,
  recordEvent,
  recordStatus,
} from "./session-events.ts";
import { openInterruptFor, turnInterruptPending } from "./turn-interrupts.ts";
import {
  acquireFence,
  leaseHeld,
  OPEN_TURN_STATUSES,
  parseTurnId,
} from "./worker-unit-of-work.ts";

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

// The event a worker that hands publication over would have published: the
// display copy it registered, which is already redacted, plus the expiry
// only the control plane knows.
function questionEvent(
  requestId: string,
  request: RegisterPendingInput["request"],
  announce: NonNullable<RegisterPendingInput["announce"]>,
  expiresAt: Date,
) {
  return {
    request_id: requestId,
    tool_use_id: announce.tool_use_id,
    kind: request.kind,
    // A permission names its tool in the request, which is what the
    // callback and the pending list act on; the announce cannot restate it.
    tool: request.kind === "permission" ? request.tool : announce.tool,
    input:
      request.kind === "permission"
        ? request.input
        : { questions: request.questions },
    expires_at: expiresAt.toISOString(),
  };
}

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
        if (!turn) return { outcome: "turn_not_found" };

        const [existing] = await tx
          .select()
          .from(pendingRequests)
          .where(eq(pendingRequests.requestId, input.requestId))
          .limit(1)
          .for("update");
        const at = await dbNow(tx);
        if (existing) {
          // A retry of a registration whose response was lost. It stays the
          // same registration — same expiry, answered or not, turn closed or
          // not — until the worker settles it; after that the id is spent.
          // Refusing it once the turn closed would tell the worker no row
          // exists, and it would drop the settlement the row still needs.
          const same =
            existing.sessionId === fence.sessionId &&
            existing.attemptId === fence.attemptId &&
            existing.turnId === turn.id &&
            existing.kind === input.request.kind &&
            existing.inputHash === input.inputHash &&
            existing.toolUseId === (input.announce?.tool_use_id ?? null) &&
            existing.tool === (input.announce?.tool ?? null) &&
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
        // A new registration only in the turn this attempt is running: a
        // callback belongs to the turn that raised it, and a closed turn has
        // no callback left.
        if (!OPEN_TURN_STATUSES.includes(turn.status)) {
          return { outcome: "turn_not_found" };
        }
        // Accepting the interrupt invalidated the turn's open requests; one
        // registered after it would be a callback nobody can answer.
        if (await turnInterruptPending(tx, turn.id)) {
          return { outcome: "turn_interrupted" };
        }
        if (!leaseHeld(fenced.attempt, at)) return { outcome: "lease_expired" };
        const expiresAt = new Date(at.getTime() + input.ttlMs);
        // Read before the insert: whether the stream already says this
        // session is waiting, and whether that is still true. An earlier
        // wait that lapsed with no write is reported first, so the stream
        // does not run one wait into the next.
        const waiting =
          input.announce !== undefined &&
          (await awaitingInputAt(tx, fence.sessionId, at));
        if (
          input.announce !== undefined &&
          fenced.session.inputAnnounced &&
          !waiting
        ) {
          await recordStatus(tx, {
            sessionId: fence.sessionId,
            phase: publicStatus(fenced.session.status, false),
            turnRowId: turn.id,
            now: at,
          });
        }
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
          toolUseId: input.announce?.tool_use_id ?? null,
          tool: input.announce?.tool ?? null,
        });
        if (input.announce !== undefined) {
          // The question first, then the status it opens, in this
          // transaction: a client never sees needs_input for a question it
          // has not been shown. The session row is locked by the fence.
          await recordEvent(tx, {
            sessionId: fence.sessionId,
            type: "question",
            payload: questionEvent(
              input.requestId,
              input.request,
              input.announce,
              expiresAt,
            ),
            turnRowId: turn.id,
            attemptId: fence.attemptId,
            now: at,
          });
          if (!(fenced.session.inputAnnounced && waiting)) {
            await recordStatus(tx, {
              sessionId: fence.sessionId,
              phase: publicStatus(fenced.session.status, true),
              turnRowId: turn.id,
              now: at,
            });
          }
        }
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
        const locked =
          input.settled.length === 0
            ? []
            : await tx
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
        const due = await tx
          .select({
            requestId: pendingRequests.requestId,
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
        const control = await openInterruptFor(tx, {
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
        });
        // The session row was locked with the fence, so this is the pause
        // as the attempt's lease sees it.
        const [pause] =
          fenced.session.admissionState === "pausing"
            ? await tx
                .select({ id: receipts.id, createdAt: receipts.createdAt })
                .from(receipts)
                .where(openPauseReceipt(fence.sessionId))
                .limit(1)
            : [];
        // Judged after every read that can wait on a lock and before the
        // first write: returning lease_expired does not roll back, and an
        // answer handed over after the lease ended would let the engine act
        // for an owner that is gone.
        const at = await dbNow(tx);
        if (!leaseHeld(fenced.attempt, at)) {
          return { outcome: "lease_expired" };
        }
        const byId = new Map(locked.map((row) => [row.requestId, row]));
        const waitingBefore =
          locked.length > 0 && (await inputWaitBefore(tx, fenced.session, at));
        const settledNow = new Set<string>();
        const settledTurns = new Set<number>();
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
          settledNow.add(row.requestId);
          settledTurns.add(row.turnId);
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
        if (settledNow.size > 0) {
          await announceInputWaitEnded(tx, {
            sessionId: fence.sessionId,
            waitingBefore,
            // The turn whose requests this call closed; a retried batch
            // can also carry rows an earlier call already settled.
            turnRowId:
              settledTurns.size === 1 ? ([...settledTurns][0] ?? null) : null,
            at,
          });
        }
        const rows = due.filter((row) => !settledNow.has(row.requestId));
        return {
          outcome: "ok",
          control:
            control !== null
              ? {
                  controlId: control.controlId,
                  kind: "interrupt",
                  turnId: String(control.turnSequence),
                  issuedAt: control.issuedAt,
                }
              : pause === undefined
                ? null
                : {
                    controlId: pause.id,
                    kind: "pause",
                    turnId: null,
                    issuedAt: pause.createdAt,
                  },
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
      if (row !== undefined) return true;
      if (
        (await openInterruptFor(db, {
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
        })) !== null
      ) {
        return true;
      }
      const [pausing] = await db
        .select({ one: sql<number>`1` })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, fence.sessionId),
            eq(sessions.admissionState, "pausing"),
          ),
        )
        .limit(1);
      return pausing !== undefined;
    },
  };
}
