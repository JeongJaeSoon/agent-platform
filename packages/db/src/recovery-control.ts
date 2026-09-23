import { randomUUID } from "node:crypto";
import type {
  ControlAcceptedResponse,
  RecoveryDecisionResult as RecoveryDecisionReceiptResult,
  ResumeReceiptResult,
} from "@agent-platform/contracts";
import type {
  RecoveryDecisionInput,
  RecoveryDecisionResult,
  ResumeSessionInput,
  ResumeSessionResult,
} from "@agent-platform/platform";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  controlClock,
  earliestUnknownTurn,
  findIdempotent,
  type IdempotencyScope,
  INPUT_RECEIPT_OPERATIONS,
  lockIdempotencyScope,
  lockSessionForControl,
  parseTurnSequence,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { lastLaunchPartition } from "./enqueue.ts";
import type { Database } from "./queries.ts";
import {
  checkpoints,
  events,
  executions,
  idempotencyKeys,
  pendingRequests,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";

const RECOVERY_DECISION = "recovery_decision";
const RESUME = "resume";
// Control receipts a close supersedes: whichever of these is still open
// was waiting on an outcome the close makes irrelevant.
const SUPERSEDED_CONTROL_OPERATIONS = ["terminate", "resume"];

type SessionRow = typeof sessions.$inferSelect;

async function turnBySequence(tx: Database, sessionId: string, turnId: string) {
  const sequence = parseTurnSequence(turnId);
  if (sequence === null) return null;
  const [turn] = await tx
    .select({
      id: turns.id,
      sequence: turns.sequence,
      status: turns.status,
      resultJson: turns.resultJson,
    })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)))
    .limit(1);
  return turn ?? null;
}

/**
 * Whether the checkpoint the session points at can be restored from. A
 * durable blocker (94S-201: a dropped transcript mirror batch) means the
 * pointer may have been taken by the run whose mirror is missing entries, so
 * it is not trusted until a later run commits past it.
 *
 * Deliberately coarse: a pointer committed by an earlier, healthy run would
 * be safe, but checkpoints do not record their attempt. If that case shows
 * up in practice, key the check on the pointer's attempt against
 * checkpoint_pending_attempt_id instead.
 */
function hasRestorePoint<
  T extends {
    checkpointRevision: number | null;
    checkpointPendingReason: string | null;
  },
>(session: T): session is T & { checkpointRevision: number } {
  return (
    session.checkpointRevision !== null &&
    session.checkpointPendingReason === null
  );
}

/**
 * Where a recovery close applies: a session waiting on an operator
 * (recovery_required), one whose terminate is still waiting on the kill
 * (stopping), and a stopped one that cannot be resumed — no restore point,
 * or an unknown turn left. Anything else is an ordinary close, which this
 * endpoint must not stand in for.
 */
async function closableByRecovery(
  tx: Database,
  session: SessionRow,
): Promise<boolean> {
  if (
    session.admissionState === "recovery_required" ||
    session.admissionState === "stopping"
  ) {
    return true;
  }
  if (session.admissionState !== "stopped") return false;
  return (
    !hasRestorePoint(session) ||
    (await earliestUnknownTurn(tx, session.id)) !== null
  );
}

/**
 * api.md § 최소 운영 복구: confirm_completed needs a consistent checkpoint up
 * to the input's watermark. The pointer is only ever moved by finalize, so
 * "consistent" means the committed checkpoint the session points at was
 * taken at or after the target turn. An older one would resume the session
 * without the work the operator is confirming.
 */
async function checkpointCovers(
  tx: Database,
  session: SessionRow,
  turnSequence: number,
): Promise<boolean> {
  if (!hasRestorePoint(session)) return false;
  const [row] = await tx
    .select({ sequence: turns.sequence })
    .from(checkpoints)
    .innerJoin(turns, eq(turns.id, checkpoints.turnId))
    .where(
      and(
        eq(checkpoints.sessionId, session.id),
        eq(checkpoints.revision, session.checkpointRevision),
      ),
    )
    .limit(1);
  return row !== undefined && row.sequence >= turnSequence;
}

// Every control decision leaves its audit record on the session's event
// stream, where the operator and the SSE reader (94S-126) both find it.
async function recordAudit(
  tx: Database,
  input: {
    sessionId: string;
    type: "system" | "status";
    payload: Record<string, unknown>;
    turnRowId: number | null;
    now: Date;
  },
) {
  await tx.insert(events).values({
    sessionId: input.sessionId,
    type: input.type,
    payload: input.payload,
    turnId: input.turnRowId,
    occurredAt: input.now,
  });
  await tx.execute(sql`SELECT pg_notify('session_events', ${input.sessionId})`);
}

async function writeReceipt(
  tx: Database,
  input: {
    scope: IdempotencyScope;
    payloadHash: string;
    turnId: string | null;
    result: unknown;
    now: Date;
  },
): Promise<ControlAcceptedResponse> {
  const receiptId = randomUUID();
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: input.scope.principal,
    operation: input.scope.operation,
    targetRef: {
      session_id: input.scope.resource,
      turn_id: input.turnId,
      request_id: null,
    },
    // Complete as soon as it is durable: nothing outside the transaction
    // has to happen for the decision itself to hold.
    status: "succeeded",
    result: input.result,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await tx.insert(idempotencyKeys).values({
    principal: input.scope.principal,
    operation: input.scope.operation,
    resource: input.scope.resource,
    key: input.scope.key,
    payloadHash: input.payloadHash,
    receiptId,
  });
  return { receipt_id: receiptId, receipt_status: "succeeded" };
}

async function cancelQueuedInput(
  tx: Database,
  input: {
    sessionId: string;
    terminalReason: string;
    error: { code: "SESSION_CLOSED"; message: string };
    now: Date;
  },
) {
  const cancelled = await tx
    .update(turns)
    .set({
      status: "cancelled",
      endedAt: input.now,
      terminalReason: input.terminalReason,
    })
    .where(
      and(eq(turns.sessionId, input.sessionId), eq(turns.status, "queued")),
    )
    .returning({ id: turns.id, sequence: turns.sequence });
  if (cancelled.length === 0) return cancelled;
  await tx.delete(queueMessages).where(
    inArray(
      queueMessages.turnId,
      cancelled.map((turn) => turn.id),
    ),
  );
  // `result` stays for the same reason as in terminate: a retry of the
  // original request replays its acceptance from it.
  await tx
    .update(receipts)
    .set({ status: "failed", error: input.error, updatedAt: input.now })
    .where(
      and(
        inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
        eq(receipts.status, "accepted"),
        sql`${receipts.targetRef}->>'session_id' = ${input.sessionId}`,
        inArray(
          sql`${receipts.targetRef}->>'turn_id'`,
          cancelled.map((turn) => String(turn.sequence)),
        ),
      ),
    );
  return cancelled;
}

// The input receipt an unknown turn left behind. Only `unknown` rows are
// touched: an `accepted` one belongs to input that never ran, and a decision
// never rewrites `result`, which the idempotent retry of the original request
// replays (see 94S-265 for the same defect in finalize).
function unknownInputReceiptOf(sessionId: string, turnSequence: number) {
  return and(
    inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
    eq(receipts.status, "unknown"),
    sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
    sql`${receipts.targetRef}->>'turn_id' = ${String(turnSequence)}`,
  );
}

// What the turn keeps once an operator settles it. The worker's finalize
// identity (finalize_key/finalize_hash) goes: a late finalize replay must
// meet a conflict, not a status the worker vocabulary cannot parse. The
// SDK result and usage, if the worker got that far, stay.
function settledResultJson(
  existing: unknown,
  decision: { decision: string; evidence_ref: string | null; reason: string },
): Record<string, unknown> {
  const {
    finalize_key: _key,
    finalize_hash: _hash,
    ...kept
  } = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {};
  return { ...kept, operator_decision: decision };
}

/**
 * api.md § 최소 운영 복구. abandon and confirm_completed settle one
 * outcome_unknown turn and leave the session `stopped`; close ends it.
 * None of them dispatches: queued input waits for an explicit resume, and
 * the decision receipt says whether one is possible.
 */
export function decideRecoveryAtomic(
  db: Database,
  input: RecoveryDecisionInput,
): Promise<RecoveryDecisionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    operation: RECOVERY_DECISION,
    resource: sessionId,
    key: input.idempotencyKey,
  };
  const startedAt = Date.now();
  const decision = input.decision;

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
    if (session.revision !== decision.expected_revision) {
      return {
        outcome: "revision_conflict",
        currentRevision: session.revision,
      };
    }
    // Same refusal as terminate: a pod-lifecycle session has no execution
    // whose absence could be confirmed and no kill a close could record.
    if (session.podId !== null && session.executionId === null) {
      return { outcome: "unsupported" };
    }

    let targetTurnRowId: number | null = null;
    if (decision.decision === "close") {
      if (!(await closableByRecovery(tx, session))) {
        return {
          outcome: "not_in_recovery",
          admissionState: session.admissionState,
        };
      }
      await close(tx, session, now);
    } else {
      // The exit that made the turn unknown must be observed before its
      // outcome is decided: until then the executions row is the only
      // record of what is still running, and confirmExecutionGone may yet
      // write to the same turn.
      if (session.executionId !== null) {
        return { outcome: "execution_unconfirmed" };
      }
      const turn = await turnBySequence(tx, sessionId, decision.target_turn_id);
      if (!turn || turn.status !== "outcome_unknown") {
        return {
          outcome: "turn_not_unknown",
          turnStatus: turn?.status ?? null,
        };
      }
      if (
        decision.decision === "confirm_completed" &&
        !(await checkpointCovers(tx, session, turn.sequence))
      ) {
        return { outcome: "checkpoint_not_covering" };
      }
      targetTurnRowId = turn.id;
      if (decision.decision === "abandon") {
        await abandon(tx, sessionId, turn, decision.reason, now);
      } else {
        await confirmCompleted(tx, sessionId, turn, decision, now);
      }
      await tx
        .update(sessions)
        .set({
          revision: sql`${sessions.revision} + 1`,
          admissionState: "stopped",
          status: "stopped",
          updatedAt: now,
        })
        .where(eq(sessions.id, sessionId));
    }

    const [after] = await tx
      .select({
        admissionState: sessions.admissionState,
        checkpointRevision: sessions.checkpointRevision,
        checkpointPendingReason: sessions.checkpointPendingReason,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!after) throw new Error(`Session ${sessionId} vanished mid-decision`);
    const unknownLeft = await earliestUnknownTurn(tx, sessionId);
    const result: RecoveryDecisionReceiptResult = {
      resulting_admission_state: after.admissionState,
      checkpoint_revision: after.checkpointRevision,
      resumable:
        after.admissionState === "stopped" &&
        hasRestorePoint(after) &&
        unknownLeft === null,
    };
    await recordAudit(tx, {
      sessionId,
      type: "system",
      payload: {
        type: "system",
        subtype: RECOVERY_DECISION,
        decision: decision.decision,
        target_turn_id:
          decision.decision === "close" ? null : decision.target_turn_id,
        evidence_ref:
          decision.decision === "confirm_completed"
            ? decision.evidence_ref
            : null,
        reason: decision.reason,
        actor: { owner_id: input.principal.ownerId },
        ...result,
      },
      turnRowId: targetTurnRowId,
      now,
    });
    const response = await writeReceipt(tx, {
      scope,
      payloadHash: input.payloadHash,
      turnId: decision.decision === "close" ? null : decision.target_turn_id,
      result,
      now,
    });
    return { outcome: "accepted", response };
  });
}

// The input is given up: it will not run again and its queue head goes,
// but the outcome flag stays true because what the execution did outside
// before it vanished is still unknown. Nothing here undoes those effects.
async function abandon(
  tx: Database,
  sessionId: string,
  turn: { id: number; sequence: number; resultJson: unknown },
  reason: string,
  now: Date,
) {
  await tx
    .update(turns)
    .set({
      status: "cancelled",
      terminalReason: "operator_abandoned",
      endedAt: now,
      resultJson: settledResultJson(turn.resultJson, {
        decision: "abandon",
        evidence_ref: null,
        reason,
      }),
    })
    .where(eq(turns.id, turn.id));
  await tx.delete(queueMessages).where(eq(queueMessages.turnId, turn.id));
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "SESSION_STOPPED",
        message:
          "input abandoned by an operator recovery decision; it will not run again and effects it already had outside are not reverted",
      },
      updatedAt: now,
    })
    .where(unknownInputReceiptOf(sessionId, turn.sequence));
}

// The operator vouches, with evidence, that the turn's work is done. The
// turn ends completed and its input receipt succeeds. The checkpoint pointer
// is not moved (only finalizeAtomic commits one); the caller has already
// checked that it reaches this turn.
async function confirmCompleted(
  tx: Database,
  sessionId: string,
  turn: { id: number; sequence: number; resultJson: unknown },
  decision: { evidence_ref: string; reason: string },
  now: Date,
) {
  await tx
    .update(turns)
    .set({
      status: "completed",
      outcomeUnknown: false,
      terminalReason: "operator_confirmed",
      endedAt: now,
      resultJson: settledResultJson(turn.resultJson, {
        decision: "confirm_completed",
        evidence_ref: decision.evidence_ref,
        reason: decision.reason,
      }),
    })
    .where(eq(turns.id, turn.id));
  await tx.delete(queueMessages).where(eq(queueMessages.turnId, turn.id));
  await tx
    .update(receipts)
    .set({ status: "succeeded", error: null, updatedAt: now })
    .where(unknownInputReceiptOf(sessionId, turn.sequence));
}

// The session ends unrecoverable. Queued input is cancelled and pending
// requests invalidated as for terminate; an execution still bound gets the
// same kill outbox, and whatever control receipt was waiting on that kill
// or on a resume is closed as superseded so nothing stays `accepted`.
// outcome_unknown turns keep that status: closing does not answer them.
async function close(tx: Database, session: SessionRow, now: Date) {
  await cancelQueuedInput(tx, {
    sessionId: session.id,
    terminalReason: "closed",
    error: {
      code: "SESSION_CLOSED",
      message: "input cancelled by close before it ran",
    },
    now,
  });
  await tx
    .update(pendingRequests)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(pendingRequests.sessionId, session.id),
        isNull(pendingRequests.resolvedAt),
      ),
    );
  await tx
    .delete(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, session.id));
  if (session.executionId !== null) {
    const outbox = await tx
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, session.executionId))
      .returning({ id: executions.id });
    if (outbox.length !== 1) {
      throw new Error(
        `Session ${session.id} points at execution ${session.executionId} which has no row`,
      );
    }
    // As in terminate (94S-220): a rebuild the scheduler still intends
    // would otherwise follow the kill.
    await tx
      .update(workerLaunches)
      .set({ replacementReason: null })
      .where(eq(workerLaunches.executionId, session.executionId));
  }
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "CONTROL_SUPERSEDED",
        message: "superseded by an operator close decision",
      },
      updatedAt: now,
    })
    .where(
      and(
        inArray(receipts.operation, SUPERSEDED_CONTROL_OPERATIONS),
        inArray(receipts.status, ["accepted", "unknown"]),
        sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
      ),
    );
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      // The epoch moves whether or not something is bound: a worker that
      // was still up is fenced out from here.
      leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
      admissionState: "closed",
      status: "stopped",
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
}

/**
 * api.md § 일시 중지와 저장 상태, stopped case: the session admits input
 * again from its committed checkpoint. Unknown turns and unconfirmed exits
 * are the operator's to settle first, and a session with no checkpoint has
 * nothing to restore. Cancelled input stays cancelled; what is still
 * queued is signalled for a new worker.
 */
export function resumeAtomic(
  db: Database,
  input: ResumeSessionInput,
): Promise<ResumeSessionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const scope: IdempotencyScope = {
    principal: input.principal.ownerId,
    operation: RESUME,
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
    // stopping: the kill is not yet observed. recovery_required: a turn is
    // unknown. Both are RECOVERY_REQUIRED to the caller; the pause family
    // resumes through 94S-138 and is refused here rather than half-done.
    if (
      session.admissionState === "stopping" ||
      session.admissionState === "recovery_required"
    ) {
      return {
        outcome: "recovery_required",
        unconfirmedTurnId: await earliestUnknownTurn(tx, sessionId),
      };
    }
    if (session.admissionState !== "stopped") {
      return { outcome: "rejected", admissionState: session.admissionState };
    }
    const unknown = await earliestUnknownTurn(tx, sessionId);
    if (unknown !== null) {
      return { outcome: "recovery_required", unconfirmedTurnId: unknown };
    }
    // Resuming onto an untrusted pointer would also wedge an idle session:
    // appends stay refused while the blocker stands, and only a new run's
    // checkpoint clears it. Close is the way out instead.
    if (!hasRestorePoint(session)) {
      return { outcome: "checkpoint_unavailable" };
    }
    if (session.podId !== null) return { outcome: "unsupported" };

    const [queuedRow] = await tx
      .select({ queued: count() })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")));
    const queued = queuedRow?.queued ?? 0;
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
        admissionState: "active",
        status: queued > 0 ? "queued" : "idle",
        updatedAt: now,
      })
      .where(eq(sessions.id, sessionId));
    if (queued > 0) {
      // Back to the partition the session last ran in; the row may already
      // exist from before the stop, in which case it is re-dated.
      const launch = await lastLaunchPartition(tx, sessionId);
      await tx
        .insert(unassignedSessions)
        .values({
          sessionId,
          signaledAt: now,
          partition: launch?.partition ?? "default",
        })
        .onConflictDoUpdate({
          target: unassignedSessions.sessionId,
          set: { signaledAt: now, partition: launch?.partition ?? "default" },
        });
    } else {
      // Nothing to run: a signal left over from before the stop would
      // launch a worker with no input. The next message re-signals.
      await tx
        .delete(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId));
    }
    const result: ResumeReceiptResult = {
      resulting_admission_state: "active",
      checkpoint_revision: session.checkpointRevision,
      queued_turn_count: queued,
    };
    await recordAudit(tx, {
      sessionId,
      type: "status",
      payload: {
        phase: queued > 0 ? "queued" : "idle",
        admission_state: "active",
        resumed_from_checkpoint_revision: session.checkpointRevision,
        actor: { owner_id: input.principal.ownerId },
      },
      turnRowId: null,
      now,
    });
    const response = await writeReceipt(tx, {
      scope,
      payloadHash: input.payloadHash,
      turnId: null,
      result,
      now,
    });
    return { outcome: "accepted", response };
  });
}
