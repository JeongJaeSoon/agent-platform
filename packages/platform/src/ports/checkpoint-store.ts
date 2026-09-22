import type { CheckpointRef } from "@agent-platform/contracts";

export type CheckpointPointer = {
  committedAt: Date;
  manifestRef: string;
  manifestSha256: string;
  revision: number;
  turnId: string | null;
};

export type CommitCheckpointInput = {
  checkpoint: CheckpointRef;
  now: Date;
  sessionId: string;
  turnId: string | null;
};

export type CommitCheckpointResult =
  | { outcome: "committed" | "replayed"; revision: number }
  // The pointer already stands at this revision or a later one: another epoch
  // finalized while this one was uploading.
  | { outcome: "conflict"; currentRevision: number | null };

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
