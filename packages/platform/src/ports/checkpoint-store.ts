import type { CheckpointRef } from "@agent-platform/contracts";

export type CheckpointPointer = {
  committedAt: Date;
  manifestRef: string;
  manifestSha256: string;
  /**
   * The object version of the manifest finalize verified (the checkpoint
   * ref's `manifest_version`). Restore reads exactly that version. Null or
   * absent for a checkpoint committed without one, which only an
   * `objectProtection: "unversioned"` deployment restores.
   */
  manifestVersion?: string | null;
  revision: number;
  turnId: string | null;
  /**
   * True only for a checkpoint a `locked` finalize committed: every version
   * it names was hashed by that version and held before the pointer moved.
   * Server-owned; absent reads as false.
   */
  versionsHeld?: boolean;
};

/**
 * The identity a post-claim write is fenced on, as the worker protocol defines
 * it. It travels with the commit so the pointer update and the ownership check
 * happen in one transaction: an execution whose lease has been taken over must
 * not win the next revision just because it uploaded first.
 */
export type CheckpointFence = {
  attemptId: string;
  authRevision: number;
  executionGeneration: number;
  leaseEpoch: number;
  sessionId: string;
};

export type CommitCheckpointInput = {
  checkpoint: CheckpointRef;
  fence: CheckpointFence;
  now: Date;
  sessionId: string;
  turnId: string | null;
  /** The verifier's `versionsHeld`, recorded on the pointer. */
  versionsHeld?: boolean;
};

export type CommitCheckpointResult =
  | { outcome: "committed" | "replayed"; revision: number }
  // The pointer already stands at this revision or a later one: another epoch
  // finalized while this one was uploading.
  | { outcome: "conflict"; currentRevision: number | null }
  // The fence no longer matches the session row; another epoch owns it.
  | { outcome: "stale_epoch" | "lease_expired" };

/**
 * The durable half of a checkpoint. `commitAtomic` inserts the checkpoint row
 * and advances the session pointer in one transaction, conditional on the
 * pointer still standing where the caller saw it — the object store and the
 * database cannot share a transaction, so the pointer is what decides which
 * uploaded manifest is the session's truth.
 */
export interface CheckpointStore {
  commitAtomic(input: CommitCheckpointInput): Promise<CommitCheckpointResult>;
  readPointer(sessionId: string): Promise<CheckpointPointer | null>;
}
