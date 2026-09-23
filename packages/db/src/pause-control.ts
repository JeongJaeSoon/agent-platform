import { randomUUID } from "node:crypto";
import type {
  ControlAcceptedResponse,
  PauseBlockedReason,
  PauseReceiptResult,
  SessionAttention,
} from "@agent-platform/contracts";
import type {
  PauseSessionInput,
  PauseSessionResult,
} from "@agent-platform/platform";
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import { contextCoverage } from "./context-gap.ts";
import {
  controlClock,
  findIdempotent,
  hasRestorePoint,
  type IdempotencyScope,
  lockIdempotencyScope,
  lockSessionForControl,
  OPEN_TURN_STATUSES,
  recordAudit,
  restoreBaseRevision,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  attempts,
  executions,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  turns,
  workerLaunches,
} from "./schema.ts";

export const PAUSE = "pause";

/**
 * api.md § 일시 중지와 저장 상태: the initial drain observation deadline.
 * Past it a pause still short of its safe boundary shows why; nothing is
 * killed on account of it.
 */
export const PAUSE_DRAIN_DEADLINE_MS = 60_000;

type SessionRow = typeof sessions.$inferSelect;

/**
 * Why the session cannot be called paused yet, or null when it can: no turn
 * is open, and a trusted committed checkpoint exists that was taken at or
 * after the last turn that ran.
 */
export async function pauseBlocker(
  tx: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "checkpointRevision"
    | "checkpointFallbackRevision"
    | "checkpointPendingReason"
    | "contextResetCheckpointRevision"
  >,
): Promise<PauseBlockedReason | null> {
  // A dropped mirror batch outranks everything: no amount of waiting makes
  // this run's transcript restorable (94S-201).
  if (session.checkpointPendingReason === "mirror_error") {
    return "mirror_error";
  }
  const [open] = await tx
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, session.id),
        inArray(turns.status, OPEN_TURN_STATUSES),
      ),
    )
    .limit(1);
  if (open) {
    const [asking] = await tx
      .select({ id: pendingRequests.requestId })
      .from(pendingRequests)
      .where(
        and(
          eq(pendingRequests.sessionId, session.id),
          eq(pendingRequests.turnId, open.id),
          isNull(pendingRequests.resolvedAt),
        ),
      )
      .limit(1);
    return asking ? "pending_request" : "long_turn";
  }
  // Every pause stands on a committed checkpoint, a session that never ran
  // a turn included: a paused receipt promises a restore point. An advisory
  // pending reason does not block by itself (94S-284): a refused drain
  // checkpoint leaves the pointer short of the last turn and the coverage
  // check below refuses it; a pointer that covers every turn is enough.
  // checkpoint_pending_reason already tells the owner which one it was, so
  // PAUSE_BLOCKED gets no reason of its own for it.
  // A start_fresh watermark does not count here: a pause needs a checkpoint
  // to resume from, not a gap an operator already accepted.
  if (!hasRestorePoint(session)) return "checkpoint_unavailable";
  // After a fallback restore it is the earlier revision the session runs
  // on that has to cover the last turn (94S-204), not the damaged pointer.
  const { lastRanTurn, checkpointedTurn } = await contextCoverage(
    tx,
    session,
    restoreBaseRevision(session),
  );
  if (lastRanTurn === null) return null;
  // A turn-less checkpoint (CheckpointService.finalize, not reachable from a
  // worker yet) records no turn it was taken after, so it is not counted as
  // covering one. Record a watermark on checkpoints when a drain starts
  // committing them.
  return checkpointedTurn !== null && checkpointedTurn >= lastRanTurn
    ? null
    : "checkpoint_unavailable";
}

export async function pauseReceiptResult(
  tx: Database,
  session: Pick<
    SessionRow,
    "id" | "checkpointRevision" | "checkpointFallbackRevision"
  >,
): Promise<PauseReceiptResult> {
  const [queued] = await tx
    .select({ count: count() })
    .from(turns)
    .where(and(eq(turns.sessionId, session.id), eq(turns.status, "queued")));
  return {
    resulting_admission_state: "paused",
    // What the pause was judged safe on, and what a resume restores.
    checkpoint_revision: restoreBaseRevision(session),
    queued_turn_count: queued?.count ?? 0,
  };
}

/**
 * The pause receipt still waiting on its execution, if the session has one.
 * Only looked up while the session is `pausing`, the one state that can
 * hold it, since the target_ref match reads receipts without an index. A
 * partial index like receipts_open_terminate_idx is the upgrade once pauses
 * are frequent enough for that read to show.
 */
export function openPauseReceipt(sessionId: string) {
  return and(
    eq(receipts.operation, PAUSE),
    eq(receipts.status, "accepted"),
    sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
  );
}

/**
 * PAUSE_BLOCKED once the drain deadline has passed with the pause still
 * short of its safe boundary. Worked out on read from the same facts the
 * pause is settled on, so it cannot disagree with them or outlive them.
 */
export async function pauseAttention(
  db: Database,
  session: Pick<
    SessionRow,
    | "id"
    | "admissionState"
    | "checkpointRevision"
    | "checkpointFallbackRevision"
    | "checkpointPendingReason"
    | "contextResetCheckpointRevision"
  >,
): Promise<SessionAttention | null> {
  if (session.admissionState !== "pausing") return null;
  const [overdue] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        openPauseReceipt(session.id),
        lte(receipts.createdAt, fromDbNow(-PAUSE_DRAIN_DEADLINE_MS)),
      ),
    )
    .limit(1);
  if (!overdue) return null;
  const reason = await pauseBlocker(db, session);
  return reason === null ? null : { code: "PAUSE_BLOCKED", reason };
}

/**
 * api.md § 일시 중지와 저장 상태. A bound session goes `pausing`: its worker
 * learns of it through pendingControl, stops taking input, finishes the
 * turn in flight with its checkpoint and releases; the receipt succeeds when
 * the execution is observed gone (confirmExecutionGoneAtomic). A session with
 * nothing running has nothing to drain and is paused in this transaction.
 * Queued input and open questions are left as they are either way.
 */
export function pauseAtomic(
  db: Database,
  input: PauseSessionInput,
): Promise<PauseSessionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    operation: PAUSE,
    resource: sessionId,
    key: input.idempotencyKey,
  };
  const startedAt = Date.now();

  return transactionWithBindingRetry(db, async (tx, attempt) => {
    await lockIdempotencyScope(tx, scope);
    const existing = await findIdempotent(tx, scope);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        return { outcome: "conflict" };
      }
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
    if (session.admissionState !== "active") {
      return { outcome: "rejected", admissionState: session.admissionState };
    }
    if (session.executionId === null && session.podId !== null) {
      return { outcome: "unsupported" };
    }

    // Only a claimed attempt still holding the binding can drain. A launch
    // reserved and not yet claimed never will be now — claims take active
    // sessions only — and an attempt that ended is on its way out anyway.
    const drainer =
      session.executionId === null
        ? undefined
        : (
            await tx
              .select({ id: attempts.id })
              .from(workerLaunches)
              .innerJoin(
                attempts,
                eq(attempts.id, workerLaunches.claimedAttemptId),
              )
              .where(
                and(
                  eq(workerLaunches.executionId, session.executionId),
                  notInArray(attempts.state, ["exited", "lost"]),
                ),
              )
              .limit(1)
          )[0];
    const bound = session.executionId !== null;
    if (drainer === undefined) {
      // Nothing will run again before a resume, so the checkpoint there is
      // now is the one the pause stands on.
      if ((await pauseBlocker(tx, session)) !== null) {
        return { outcome: "checkpoint_unavailable" };
      }
      if (session.executionId !== null) {
        // The stop intent right away, as terminate writes it: the launch
        // row is locked (lockSessionForControl), so a rebuild the scheduler
        // intended is cancelled with it (94S-220).
        await tx
          .update(executions)
          .set({ desiredState: "terminated" })
          .where(eq(executions.id, session.executionId));
        await tx
          .update(workerLaunches)
          .set({ replacementReason: null })
          .where(eq(workerLaunches.executionId, session.executionId));
      }
    }
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        // With the stop intent the epoch goes too; a draining worker keeps
        // its own until it commits the pause by releasing.
        ...(bound && drainer === undefined
          ? { leaseEpoch: sql`${sessions.leaseEpoch} + 1` }
          : {}),
        admissionState: bound ? "pausing" : "paused",
        updatedAt: now,
      })
      .where(eq(sessions.id, sessionId));

    const receiptId = randomUUID();
    const response: ControlAcceptedResponse = {
      receipt_id: receiptId,
      receipt_status: bound ? "accepted" : "succeeded",
    };
    await tx.insert(receipts).values({
      id: receiptId,
      ownerId: scope.principal,
      operation: PAUSE,
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: response.receipt_status,
      result: bound ? null : await pauseReceiptResult(tx, session),
      // The drain deadline counts from durable acceptance, on the database
      // clock the attention check reads it with.
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
    await recordAudit(tx, {
      sessionId,
      type: "status",
      payload: {
        // Pause moves admission only; the status it reports is untouched.
        phase: session.status,
        admission_state: bound ? "pausing" : "paused",
        reason: input.reason,
        actor: { owner_id: input.principal.ownerId },
      },
      turnRowId: null,
      now,
    });
    return { outcome: "accepted", response };
  });
}
