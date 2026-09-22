import type { SessionDurability } from "@agent-platform/contracts";
import type {
  CheckpointBlockReason,
  CheckpointPreparation,
} from "@agent-platform/runtime-core";

/**
 * Which refusals outlive the turn that produced them.
 *
 * A turn in flight and a run that has not started one are ordinary states: the
 * next safe boundary checkpoints as usual. A dropped mirror batch is not — the
 * stored transcript is short entries nobody can enumerate, and every later turn
 * builds on a session that cannot be restored. Only that one is surfaced as a
 * pending reason and only that one holds work back.
 */
const DURABLE_BLOCKERS: Record<CheckpointBlockReason, boolean> = {
  mirror_error: true,
  no_engine_session: false,
  turn_in_flight: false,
};

export function checkpointPendingReason(
  preparation: CheckpointPreparation,
): CheckpointBlockReason | null {
  if (preparation.status === "ready") return null;
  return DURABLE_BLOCKERS[preparation.reason] ? preparation.reason : null;
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
  if (pendingReason === null) return { admitted: true };
  return {
    admitted: false,
    code: "CHECKPOINT_UNAVAILABLE",
    message: `Session cannot be checkpointed: ${pendingReason}`,
  };
}

export type DurabilityFacts = {
  checkpointCommittedAt: Date | null;
  checkpointRevision: number | null;
  lastCheckpointedTurnId: string | null;
  lastCompletedTurnId: string | null;
  lastTranscriptPersistedAt: Date | null;
  pendingReason: CheckpointBlockReason | null;
};

export function projectDurability(facts: DurabilityFacts): SessionDurability {
  return {
    checkpoint_committed_at: facts.checkpointCommittedAt?.toISOString() ?? null,
    checkpoint_pending_reason: facts.pendingReason,
    checkpoint_revision: facts.checkpointRevision,
    last_checkpointed_turn_id: facts.lastCheckpointedTurnId,
    last_completed_turn_id: facts.lastCompletedTurnId,
    last_transcript_persisted_at:
      facts.lastTranscriptPersistedAt?.toISOString() ?? null,
  };
}
