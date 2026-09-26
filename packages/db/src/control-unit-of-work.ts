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
  expireOverdueReceipts,
  findIdempotent,
  type IdempotencyScope,
  INPUT_RECEIPT_OPERATIONS,
  lockIdempotencyScope,
  lockSessionForControl,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { dbNow, fromDbNow } from "./db-clock.ts";
import { openPauseReceipt, pauseAtomic } from "./pause-control.ts";
import { publicStatus } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { decideRecoveryAtomic, resumeAtomic } from "./recovery-control.ts";
import { openResumeReceipt } from "./resume-control.ts";
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
import {
  announceInputWaitEnded,
  inputWaitBefore,
  recordStatus,
} from "./session-events.ts";

const TERMINATE = "terminate";
export const REVOKE_EXECUTION = "revoke_execution";
// Receipts that settle on the observed absence of the execution they asked
// to kill, and go `unknown` when that is not observed in time. A session
// cannot be bound again while either is open (terminate stops dispatch, a
// revocation blocks it), so the session identifies the execution.
export const KILL_RECEIPT_OPERATIONS = [TERMINATE, REVOKE_EXECUTION];

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
  input: { now: Date; deadlineMs: number; dryRun?: boolean; limit?: number },
): Promise<number> {
  return expireOverdueReceipts(db, {
    overdue: and(
      inArray(receipts.operation, KILL_RECEIPT_OPERATIONS),
      // The receipt was stamped by the database clock, so the deadline is
      // measured on it too; `now` only stamps the update.
      lte(receipts.createdAt, fromDbNow(-input.deadlineMs)),
    ),
    message: `execution termination not observed within ${Math.round(input.deadlineMs / 1000)}s; reconciliation continues`,
    ...input,
  });
}

type SessionRow = typeof sessions.$inferSelect;

/**
 * What stopping a session's execution writes, apart from the session row:
 * the terminate transaction (api.md § 승인·중단·강제 종료) and the operator's
 * execution revocation (94S-321) make the same writes. Queued input is
 * cancelled, open questions are closed, the bound generation's kill intent
 * is recorded and a pause or resume still in flight is superseded. The
 * caller holds the launch and session row locks (lockSessionForControl),
 * moves the session's epoch in the same transaction and then hands
 * `inputWait` to announceStopped, once the session row says where it now
 * is; `by` names the command in the errors the superseded
 * receipts carry.
 */
export async function stopExecution(
  tx: Database,
  session: SessionRow,
  input: { now: Date; by: "terminate" | "execution revocation" },
): Promise<{
  pendingKill: boolean;
  inputWait: { waitingBefore: boolean; at: Date };
}> {
  const { now, by } = input;
  const sessionId = session.id;
  // Queued input will never run: its turns end as cancelled, its queue
  // rows go, and whoever submitted it learns so through the receipt.
  const cancelled = await tx
    .update(turns)
    .set({
      status: "cancelled",
      endedAt: now,
      terminalReason: "terminated",
    })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")))
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
          message: `input cancelled by ${by} before it ran`,
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
  // Judged on the database clock, which is what the projection reads with;
  // the caller's clock only stamps the rows.
  const at = await dbNow(tx);
  const waitingBefore = await inputWaitBefore(tx, session, at);
  // A question nobody can answer any more: the worker that asked is being
  // fenced out, so an answer would land on nothing.
  await tx
    .update(pendingRequests)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(pendingRequests.sessionId, sessionId),
        isNull(pendingRequests.resolvedAt),
      ),
    );
  // The kill outbox. An executions row is one generation, so asking for this
  // row is asking for exactly the generation the session is bound to. The
  // scheduler carries it out and confirmExecutionGone settles the session
  // and the receipt once the resource is absent.
  const pendingKill = session.executionId !== null;
  if (session.executionId !== null) {
    const outbox = await tx
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, session.executionId))
      .returning({ id: executions.id });
    // A bound session without its executions row is a broken invariant,
    // not evidence that nothing is running.
    if (outbox.length !== 1) {
      throw new Error(
        `Session ${sessionId} points at execution ${session.executionId} which has no row`,
      );
    }
    // 94S-220: a launch the scheduler meant to rebuild would otherwise be
    // rebuilt after the kill, and confirmExecutionGone would refuse the exit
    // as "the rebuild in progress". The intent is cancelled under the launch
    // row lock the caller took; replacement_count is the scheduler's CAS and
    // stays as it is.
    await tx
      .update(workerLaunches)
      .set({ replacementReason: null })
      .where(eq(workerLaunches.executionId, session.executionId));
  }
  // A pause still draining is overtaken: the kill ends the execution before
  // any checkpoint the pause was waiting for. Likewise a resume still
  // waiting on its worker's restore.
  if (session.admissionState === "pausing") {
    await tx
      .update(receipts)
      .set({
        status: "failed",
        error: {
          code: "CONTROL_SUPERSEDED",
          message: `superseded by ${by} before the pause completed`,
        },
        updatedAt: now,
      })
      .where(openPauseReceipt(sessionId));
  }
  if (session.admissionState === "resuming") {
    await tx
      .update(receipts)
      .set({
        status: "failed",
        error: {
          code: "CONTROL_SUPERSEDED",
          message: `superseded by ${by} before the resume completed`,
        },
        updatedAt: now,
      })
      .where(openResumeReceipt(sessionId));
  }
  return { pendingKill, inputWait: { waitingBefore, at } };
}

/**
 * Where a stopped execution leaves the session. The caller moves the epoch
 * in the same update: from then every request the old worker makes is 409
 * STALE_EPOCH, whether or not its container is still up. A session already
 * waiting on an operator keeps `recovery_required`: the kill does not answer
 * what its unknown turn did, so it must not clear that barrier.
 */
export function stoppedAdmission(
  session: Pick<SessionRow, "admissionState">,
  pendingKill: boolean,
) {
  if (session.admissionState === "recovery_required") return {};
  return pendingKill
    ? { admissionState: "stopping" as const }
    : { admissionState: "stopped" as const, status: "stopped" as const };
}

/**
 * After the session row says where stoppedAdmission moved it: a status event
 * with the new admission, so a client following the stream does not stay at
 * the state the stop left (94S-293). The stop closed every open question, so
 * the event also ends any wait for input. A stop that moved no admission
 * only reports that end, if there was one.
 */
export async function announceStopped(
  tx: Database,
  input: {
    session: Pick<SessionRow, "id" | "admissionState" | "status">;
    into: ReturnType<typeof stoppedAdmission>;
    inputWait: { waitingBefore: boolean; at: Date };
    extra: Record<string, unknown>;
    now: Date;
  },
) {
  const { session, into } = input;
  if (
    into.admissionState === undefined ||
    into.admissionState === session.admissionState
  ) {
    await announceInputWaitEnded(tx, {
      sessionId: session.id,
      ...input.inputWait,
      turnRowId: null,
    });
    return;
  }
  await recordStatus(tx, {
    sessionId: session.id,
    phase: publicStatus(into.status ?? session.status, false),
    extra: { admission_state: into.admissionState, ...input.extra },
    turnRowId: null,
    now: input.now,
  });
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

        const { pendingKill, inputWait } = await stopExecution(tx, session, {
          now,
          by: TERMINATE,
        });
        const into = stoppedAdmission(session, pendingKill);
        // 94S-310: a stopped session with nothing to kill is already where
        // this leads. Moving its revision would only turn away the next
        // control of a client that read it, over a change that never was.
        if (session.admissionState !== "stopped" || pendingKill) {
          await tx
            .update(sessions)
            .set({
              revision: sql`${sessions.revision} + 1`,
              leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
              updatedAt: now,
              ...into,
            })
            .where(eq(sessions.id, sessionId));
        }
        await announceStopped(tx, {
          session,
          into,
          inputWait,
          extra: {
            reason: input.reason,
            actor: { owner_id: input.principal.ownerId },
          },
          now,
        });

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
