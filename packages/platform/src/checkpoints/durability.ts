import {
  checkpointBlockReasonSchema,
  type SessionDurability,
} from "@agent-platform/contracts";
import type {
  CheckpointBlockReason,
  CheckpointPreparation,
} from "@agent-platform/runtime-core";

/**
 * What each refusal means for the session, once the runtime reports it.
 *
 * - `ordinary`: a turn in flight, or a run that has not started one. The next
 *   safe boundary checkpoints as usual; nothing is recorded.
 * - `blocking`: a dropped mirror batch. The stored transcript is short entries
 *   nobody can enumerate and every later turn builds on a session that cannot
 *   be restored, so it is recorded and holds work back until a checkpoint from
 *   *another* attempt commits (this run's transcript never recovers).
 * - `advisory`: the run was not quiescent — a tool still running, a background
 *   task (a dev server may run for hours, §1.1), or another checkpoint holding
 *   the lease. The previous generation stays the one to resume from and the
 *   reason is recorded so it is visible, but work goes on: holding turns back
 *   for a server the agent was asked to keep running would stall the session.
 *   Any later commit clears it, from this attempt or another.
 *   `publish_failed` is the same for a run that was ready but whose checkpoint
 *   could not be written — a workspace the capture refused, a manifest over
 *   the limits, a store that failed. The ones that persist (a workspace too
 *   large to capture) are not fixed by holding turns back, and a replaced
 *   worker still refuses to go on past turns no checkpoint covers (94S-288).
 */
export type CheckpointReasonKind = "advisory" | "blocking" | "ordinary";

const CHECKPOINT_REASONS: Record<CheckpointBlockReason, CheckpointReasonKind> =
  {
    background_writer: "advisory",
    checkpoint_lease_held: "advisory",
    mirror_error: "blocking",
    no_engine_session: "ordinary",
    publish_failed: "advisory",
    tool_in_flight: "advisory",
    turn_in_flight: "ordinary",
  };

export function checkpointReasonKind(
  reason: CheckpointBlockReason,
): CheckpointReasonKind {
  return CHECKPOINT_REASONS[reason];
}

/** Whether a stored pending reason refuses new turns and unconfirmed completions. */
export function checkpointReasonHoldsWork(
  reason: CheckpointBlockReason | null,
): boolean {
  return reason !== null && CHECKPOINT_REASONS[reason] === "blocking";
}

/**
 * checkpointReasonHoldsWork for the reason as the session row stores it
 * (text). A value this build does not know counts as blocking: trusting a
 * pointer on an unrecognised reason is the unsafe direction.
 */
export function storedPendingReasonHoldsWork(stored: string | null): boolean {
  if (stored === null) return false;
  const parsed = checkpointBlockReasonSchema.safeParse(stored);
  return !parsed.success || checkpointReasonHoldsWork(parsed.data);
}

/** The reason to record for a refusal, or null when it leaves no trace. */
export function checkpointPendingReason(
  preparation: CheckpointPreparation,
): CheckpointBlockReason | null {
  if (preparation.status === "ready") return null;
  return CHECKPOINT_REASONS[preparation.reason] === "ordinary"
    ? null
    : preparation.reason;
}

/**
 * The pending reason after `reported` is recorded over `stored`. An advisory
 * refusal never replaces a blocking one: the session would take turns again
 * on a transcript it still cannot restore.
 */
export function nextPendingReason(
  stored: CheckpointBlockReason | null,
  reported: CheckpointBlockReason,
): CheckpointBlockReason {
  if (stored === null || checkpointReasonHoldsWork(reported)) return reported;
  return checkpointReasonHoldsWork(stored) ? stored : reported;
}

export type CheckpointAdmission =
  | { admitted: true }
  | { admitted: false; code: "CHECKPOINT_UNAVAILABLE"; message: string };

/**
 * Whether the session may take a new turn or record a terminal outcome. A
 * turn the platform cannot checkpoint must not be reported as durably finished,
 * so the SDK reporting success is not on its own enough to confirm one.
 */
export function checkpointAdmission(
  pendingReason: CheckpointBlockReason | null,
): CheckpointAdmission {
  if (!checkpointReasonHoldsWork(pendingReason)) return { admitted: true };
  return {
    admitted: false,
    code: "CHECKPOINT_UNAVAILABLE",
    message: `Session cannot be checkpointed: ${pendingReason}`,
  };
}

export type DurabilityFacts = {
  checkpointCommittedAt: Date | null;
  checkpointFallbackRevision: number | null;
  checkpointRevision: number | null;
  contextResetTurnId: string | null;
  lastCheckpointedTurnId: string | null;
  lastCompletedTurnId: string | null;
  lastTranscriptPersistedAt: Date | null;
  pendingReason: CheckpointBlockReason | null;
};

export function projectDurability(facts: DurabilityFacts): SessionDurability {
  return {
    checkpoint_committed_at: facts.checkpointCommittedAt?.toISOString() ?? null,
    checkpoint_fallback_revision: facts.checkpointFallbackRevision,
    checkpoint_pending_reason: facts.pendingReason,
    checkpoint_revision: facts.checkpointRevision,
    context_reset_turn_id: facts.contextResetTurnId,
    last_checkpointed_turn_id: facts.lastCheckpointedTurnId,
    last_completed_turn_id: facts.lastCompletedTurnId,
    last_transcript_persisted_at:
      facts.lastTranscriptPersistedAt?.toISOString() ?? null,
  };
}
