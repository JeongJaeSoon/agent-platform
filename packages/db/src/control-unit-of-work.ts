import { randomUUID } from "node:crypto";
import type {
  ControlAcceptedResponse,
  TerminateReceiptResult,
} from "@agent-platform/contracts";
import type {
  PauseSessionInput,
  RecoveryDecisionInput,
  ResumeSessionInput,
  SessionControl,
  TerminateSessionInput,
  TerminateSessionResult,
} from "@agent-platform/platform";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  controlClock,
  earliestUnknownTurn,
  findIdempotent,
  type IdempotencyScope,
  INPUT_RECEIPT_OPERATIONS,
  lockIdempotencyScope,
  lockSessionForControl,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { fromDbNow } from "./db-clock.ts";
import { openPauseReceipt, pauseAtomic } from "./pause-control.ts";
import type { Database } from "./queries.ts";
import { decideRecoveryAtomic, resumeAtomic } from "./recovery-control.ts";
import {
  executions,
  idempotencyKeys,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  workerLaunches,
} from "./schema.ts";

const TERMINATE = "terminate";

export { earliestUnknownTurn } from "./control-shared.ts";

/**
 * The receipt a terminate settles with once its execution is gone; the same
 * shape is written by confirmExecutionGoneAtomic, so a reader sees one
 * result whether the kill was immediate or observed later.
 */
export function terminateReceiptResult(input: {
  checkpointRevision: number | null;
  unconfirmedTurnId: string | null;
}): TerminateReceiptResult {
  return {
    execution_gone: true,
    checkpoint_revision: input.checkpointRevision,
    unconfirmed_turn_id: input.unconfirmedTurnId,
    external_effects_reverted: false,
  };
}

/**
 * api.md: a kill not observed within the deadline is reported unknown, not
 * left pending. The intent stays on the executions row, so reconciliation
 * continues and confirmExecutionGoneAtomic still settles the receipt later.
 * Both the scheduler pass and the DB-only reconciler run this, so a Docker
 * outage that stalls the former does not stall the answer.
 */
export async function expireOverdueTerminations(
  db: Database,
  input: { now: Date; deadlineMs: number; dryRun?: boolean },
): Promise<number> {
  const overdueWhere = and(
    eq(receipts.operation, TERMINATE),
    eq(receipts.status, "accepted"),
    // The receipt was stamped by the database clock, so the deadline is
    // measured on it too; `now` only stamps the update.
    lte(receipts.createdAt, fromDbNow(-input.deadlineMs)),
  );
  if (input.dryRun) {
    const rows = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(overdueWhere);
    return rows.length;
  }
  const overdue = await db
    .update(receipts)
    .set({
      status: "unknown",
      error: {
        code: "BACKEND_UNAVAILABLE",
        message: `execution termination not observed within ${Math.round(input.deadlineMs / 1000)}s; reconciliation continues`,
      },
      updatedAt: input.now,
    })
    .where(
      and(
        eq(receipts.operation, TERMINATE),
        eq(receipts.status, "accepted"),
        lte(receipts.createdAt, fromDbNow(-input.deadlineMs)),
      ),
    )
    .returning({ id: receipts.id });
  return overdue.length;
}

export function createPostgresSessionControl(db: Database): SessionControl {
  return {
    async terminateAtomic(
      input: TerminateSessionInput,
    ): Promise<TerminateSessionResult> {
      const sessionId = input.sessionId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.principal.ownerId,
        operation: TERMINATE,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      const startedAt = Date.now();
      return transactionWithBindingRetry(db, terminateIn);

      async function terminateIn(
        tx: Database,
        attempt: number,
      ): Promise<TerminateSessionResult> {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          // Same receipt identity as the first answer; the status is the
          // receipt's current one, since the row is the only record of it.
          return {
            outcome: "replayed",
            response: {
              receipt_id: existing.receiptId,
              receipt_status: existing.status,
            },
          };
        }

        const session = await lockSessionForControl(tx, {
          sessionId,
          ownerId: scope.principal,
          attempt,
        });
        if (!session) return { outcome: "not_found" };
        const now = controlClock(input.now, startedAt);
        if (session.admissionState === "closed") {
          return { outcome: "rejected", admissionState: "closed" };
        }
        if (session.revision !== input.expectedRevision) {
          return {
            outcome: "revision_conflict",
            currentRevision: session.revision,
          };
        }
        // A session on the legacy pod lifecycle (pod_id without an
        // execution) has no kill outbox and no epoch its worker honours.
        // Accepting would promise a kill nothing can deliver, so it is
        // refused with the row untouched.
        if (session.executionId === null && session.podId !== null) {
          return { outcome: "unsupported" };
        }

        // Queued input will never run: its turns end as cancelled, its queue
        // rows go, and whoever submitted it learns so through the receipt.
        const cancelled = await tx
          .update(turns)
          .set({
            status: "cancelled",
            endedAt: now,
            terminalReason: "terminated",
          })
          .where(
            and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")),
          )
          .returning({ id: turns.id, sequence: turns.sequence });
        if (cancelled.length > 0) {
          await tx.delete(queueMessages).where(
            inArray(
              queueMessages.turnId,
              cancelled.map((turn) => turn.id),
            ),
          );
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code: "SESSION_STOPPED",
                message: "input cancelled by terminate before it ran",
              },
              // `result` stays the acceptance response (receiptSchema.result).
              updatedAt: now,
            })
            .where(
              and(
                inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
                eq(receipts.status, "accepted"),
                sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
                inArray(
                  sql`${receipts.targetRef}->>'turn_id'`,
                  cancelled.map((turn) => String(turn.sequence)),
                ),
              ),
            );
        }
        // A question nobody can answer any more: the worker that asked is
        // being fenced out, so an answer would land on nothing.
        await tx
          .update(pendingRequests)
          .set({ resolvedAt: now })
          .where(
            and(
              eq(pendingRequests.sessionId, sessionId),
              isNull(pendingRequests.resolvedAt),
            ),
          );
        // The kill outbox. An executions row is one generation, so asking
        // for this row is asking for exactly the generation the session is
        // bound to. The scheduler carries it out and confirmExecutionGone
        // settles the session and this receipt once the resource is absent.
        const outbox =
          session.executionId === null
            ? []
            : await tx
                .update(executions)
                .set({ desiredState: "terminated" })
                .where(eq(executions.id, session.executionId))
                .returning({ id: executions.id });
        const pendingKill = session.executionId !== null;
        if (session.executionId !== null) {
          // 94S-220: a launch the scheduler meant to rebuild would otherwise
          // be rebuilt after the kill, and confirmExecutionGone would refuse
          // the exit as "the rebuild in progress". The intent is cancelled
          // under the launch row lock taken above; replacement_count is the
          // scheduler's CAS and stays as it is.
          await tx
            .update(workerLaunches)
            .set({ replacementReason: null })
            .where(eq(workerLaunches.executionId, session.executionId));
        }
        if (pendingKill && outbox.length !== 1) {
          // A bound session without its executions row is a broken
          // invariant, not evidence that nothing is running.
          throw new Error(
            `Session ${sessionId} points at execution ${session.executionId} which has no row`,
          );
        }
        // A pause still draining is overtaken: the kill ends the execution
        // before any checkpoint the pause was waiting for.
        if (session.admissionState === "pausing") {
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code: "CONTROL_SUPERSEDED",
                message: "superseded by terminate before the pause completed",
              },
              updatedAt: now,
            })
            .where(openPauseReceipt(sessionId));
        }
        // The epoch moves on in the same transaction: from here every
        // request the old worker makes is 409 STALE_EPOCH, whether or not
        // its container is still up. A session already waiting on an
        // operator keeps `recovery_required`: the kill does not answer what
        // its unknown turn did, so it must not clear that barrier.
        const keepsRecovery = session.admissionState === "recovery_required";
        await tx
          .update(sessions)
          .set({
            revision: sql`${sessions.revision} + 1`,
            leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
            updatedAt: now,
            ...(keepsRecovery
              ? {}
              : pendingKill
                ? { admissionState: "stopping" as const }
                : {
                    admissionState: "stopped" as const,
                    status: "stopped" as const,
                  }),
          })
          .where(eq(sessions.id, sessionId));

        const receiptId = randomUUID();
        const response: ControlAcceptedResponse = {
          receipt_id: receiptId,
          receipt_status: pendingKill ? "accepted" : "succeeded",
        };
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: scope.principal,
          operation: TERMINATE,
          targetRef: { session_id: sessionId, turn_id: null, request_id: null },
          status: response.receipt_status,
          // Nothing to kill: the command is complete as soon as it is durable.
          result: pendingKill
            ? null
            : terminateReceiptResult({
                checkpointRevision: session.checkpointRevision,
                unconfirmedTurnId: await earliestUnknownTurn(tx, sessionId),
              }),
          // The deadline counts from durable acceptance, not from when the
          // caller read its clock: lock waits inside this transaction must
          // not eat into the kill's observation window.
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        });
        await tx.insert(idempotencyKeys).values({
          principal: scope.principal,
          operation: scope.operation,
          resource: scope.resource,
          key: scope.key,
          payloadHash: input.payloadHash,
          receiptId,
        });
        return { outcome: "accepted", response };
      }
    },

    pauseAtomic(input: PauseSessionInput) {
      return pauseAtomic(db, input);
    },

    decideRecoveryAtomic(input: RecoveryDecisionInput) {
      return decideRecoveryAtomic(db, input);
    },

    resumeAtomic(input: ResumeSessionInput) {
      return resumeAtomic(db, input);
    },
  };
}
