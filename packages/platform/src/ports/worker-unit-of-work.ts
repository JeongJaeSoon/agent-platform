import type {
  AttemptState,
  CheckpointBlockReason,
  CheckpointRef,
  ExecutionBackend,
  FinalizeRequest,
  WorkerEvent,
  WorkspaceRepository,
} from "@agent-platform/contracts";
import type { CheckpointPointer } from "./checkpoint-store.ts";

// The identity every post-claim write is fenced on. The storage adapter puts
// these values in the WHERE clause of each write; a row that no longer
// matches means another epoch owns the session.
export type WorkerFence = {
  sessionId: string;
  attemptId: string;
  leaseEpoch: number;
  executionGeneration: number;
  authRevision: number;
};

export type FenceRejection = {
  outcome: "stale_epoch" | "lease_expired";
};

export type RegisterLaunchInput = {
  executionId: string;
  generation: number;
  partition: string;
  // The session this launch was started for, when the caller reserved one.
  sessionId: string | null;
  backend: ExecutionBackend;
  nonceHash: Uint8Array;
  // A lifetime, not a deadline: the storage clock decides when the nonce
  // stops being accepted, so the caller's clock never enters the judgment.
  nonceTtlMs: number;
};

export type WorkerBinding = {
  sessionId: string;
  attemptId: string;
  leaseEpoch: number;
  executionGeneration: number;
  authRevision: number;
  leaseExpiresAt: Date;
  profileId: string | null;
  // The session's owner partition, straight from the row; the claim hands
  // it to the worker as the checkpoint principal (94S-209).
  ownerScope: string;
  // As fixed when the session was accepted; the catalog is not consulted.
  repository: WorkspaceRepository;
  restore: CheckpointRef | null;
};

export type ClaimInput = {
  // Only a session whose profile appears here may be bound: a host that does
  // not know the profile cannot pick the runtime to start.
  runnableProfiles: string[];
  nonceHash: Uint8Array;
  executionId: string;
  executionGeneration: number;
  attemptId: string;
  credentialHash: Uint8Array;
  // Lifetimes, not deadlines: the storage clock is the one authority on when
  // a lease or token has ended, so the caller says how long, never until when.
  // `now` only stamps audit columns.
  credentialTtlMs: number;
  leaseTtlMs: number;
  now: Date;
};

export type ClaimResult =
  | { outcome: "claimed" | "replayed"; binding: WorkerBinding }
  // Unknown, expired, or presented for a different execution identity.
  | { outcome: "invalid_credential" }
  // The bound session's profile is not in this host's catalog, so the replay
  // is refused before it rotates anything.
  | { outcome: "profile_unavailable" }
  | { outcome: "no_session" };

// The fence as it stood when the token was issued. A request body may not
// name any other one: the numbers are guessable, so without this a holder of
// a token that is about to be revoked could pre-address the next revision.
export type ResolvedCredential =
  | ({ kind: "session" } & WorkerFence)
  // A launch nonce: valid only for bootstrapClaim.
  | { kind: "bootstrap" }
  | null;

export type NextInputInput = { fence: WorkerFence; now: Date };
export type DeliveredInput = {
  turnId: string;
  inputId: string;
  message: string;
  deliveryStartedAt: Date;
};
export type NextInputResult =
  | {
      outcome: "ok";
      input: DeliveredInput | null;
      leaseExpiresAt: Date;
      /** Set when the attempt is draining: nothing new is coming, so stop polling. */
      draining?: true;
    }
  | FenceRejection;

export type HeartbeatInput = {
  // A worker that keeps heartbeating keeps its token: the credential's
  // lifetime follows the lease instead of cutting a healthy attempt off at a
  // fixed horizon. Both are lifetimes measured on the storage clock.
  credentialTtlMs: number;
  fence: WorkerFence;
  now: Date;
  leaseTtlMs: number;
  attemptState: AttemptState;
  // The worker's transcript mirror as of this heartbeat. `persistedAt` only
  // ever moves the stored value forward; `mirrorError` becomes the session's
  // durable pending reason (mirror_error) until a checkpoint commits.
  transcript?: { persistedAt: Date | null; mirrorError: string | null };
};
export type HeartbeatResult =
  | { outcome: "ok"; leaseExpiresAt: Date; authRevision: number }
  | FenceRejection;

export type CommitEventsInput = {
  fence: WorkerFence;
  turnId: string | null;
  now: Date;
  events: WorkerEvent[];
};
export type CommitEventsResult =
  | { outcome: "ok"; acceptedThrough: number; cursor: string }
  | { outcome: "turn_not_found" }
  // A source_sequence this attempt already stored, with different content.
  | { outcome: "event_conflict" }
  // New events for a turn that already reached its terminal.
  | { outcome: "turn_finalized" }
  // The batch does not continue the durable prefix; acceptedThrough says
  // where the worker has to resume.
  | { outcome: "sequence_gap"; acceptedThrough: number }
  | FenceRejection;

export type FinalizeInput = {
  fence: WorkerFence;
  now: Date;
  turnId: string;
  finalizeKey: string;
  finalSourceSequence: number;
  terminal: FinalizeRequest["terminal"];
  checkpoint: CheckpointRef | null;
};
export type FinalizeOutcome = {
  turnId: string;
  status: FinalizeRequest["terminal"]["status"];
  checkpointRevision: number | null;
};
export type FinalizeResult =
  | { outcome: "finalized" | "replayed"; result: FinalizeOutcome }
  | { outcome: "turn_not_found" }
  // The turn already reached a terminal state under a different key or body.
  | { outcome: "finalize_conflict" }
  | { outcome: "checkpoint_rejected"; reason: string }
  // The checkpoint names a revision other than the pointer's next one:
  // another finalize moved it first. Ask again, upload, finalize again.
  | { outcome: "checkpoint_conflict"; currentRevision: number | null }
  // A completed terminal was offered without a checkpoint while the session
  // carries a durable pending reason: the turn cannot be reported as durably
  // finished. Interrupted/failed/unknown terminals are never held back.
  | { outcome: "checkpoint_required"; reason: CheckpointBlockReason }
  // The stream is not durable through final_source_sequence (or holds more
  // than the worker claims); acceptedThrough says what is actually stored.
  | { outcome: "events_incomplete"; acceptedThrough: number }
  | FenceRejection;

export type PeekFinalizeResult = FinalizeResult | { outcome: "open" };

export type CheckpointStateInput = {
  fence: WorkerFence;
  now: Date;
  // A durable block reason to record; undefined leaves the stored one alone.
  // Only a committed checkpoint clears it (finalizeAtomic / commitAtomic).
  pendingReason?: CheckpointBlockReason;
};
export type CheckpointStateResult =
  | {
      outcome: "ok";
      // The pointer from the same snapshot as the fence; the protocol works
      // from this rather than re-reading it unfenced.
      pointer: CheckpointPointer | null;
      pendingReason: CheckpointBlockReason | null;
    }
  | FenceRejection;

export type ReleaseInput = { fence: WorkerFence; now: Date; reason: string };
export type ReleaseResult = { released: boolean };

export type ConfirmExecutionGoneInput = { executionId: string; now: Date };
export type ConfirmExecutionGoneResult = {
  sessionReleased: boolean;
  slotReleased: boolean;
};

export interface WorkerUnitOfWork {
  registerLaunchAtomic(
    input: RegisterLaunchInput,
  ): Promise<{ outcome: "registered" | "exists" }>;
  claimAtomic(input: ClaimInput): Promise<ClaimResult>;
  // Expiry is judged on the storage clock, so no caller time is taken.
  resolveCredential(tokenHash: Uint8Array): Promise<ResolvedCredential>;
  nextInputAtomic(input: NextInputInput): Promise<NextInputResult>;
  heartbeatAtomic(input: HeartbeatInput): Promise<HeartbeatResult>;
  commitEventsAtomic(input: CommitEventsInput): Promise<CommitEventsResult>;
  // The same question finalizeAtomic answers, without committing anything:
  // it lets a caller settle a replay before doing work that can fail.
  peekFinalizeAtomic(input: FinalizeInput): Promise<PeekFinalizeResult>;
  finalizeAtomic(input: FinalizeInput): Promise<FinalizeResult>;
  // The fenced read behind the checkpoint protocol: proves the caller still
  // owns the session before a pointer is read on its behalf, and records the
  // runtime's durable refusal when it reports one.
  checkpointStateAtomic(
    input: CheckpointStateInput,
  ): Promise<CheckpointStateResult>;
  releaseAtomic(input: ReleaseInput): Promise<ReleaseResult>;
  // Called once the backend has observed the execution is gone; only then
  // does the session become claimable again and the launch slot return.
  confirmExecutionGoneAtomic(
    input: ConfirmExecutionGoneInput,
  ): Promise<ConfirmExecutionGoneResult>;
  countReservedSlots(partition?: string): Promise<number>;
}
