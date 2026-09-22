import type {
  AttemptState,
  CheckpointRef,
  FinalizeRequest,
  WorkerEvent,
} from "@agent-platform/contracts";

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
  backend: string;
  nonceHash: Uint8Array;
  nonceExpiresAt: Date;
};

export type WorkerBinding = {
  sessionId: string;
  attemptId: string;
  leaseEpoch: number;
  executionGeneration: number;
  authRevision: number;
  leaseExpiresAt: Date;
  profileId: string | null;
  restore: CheckpointRef | null;
};

export type ClaimInput = {
  nonceHash: Uint8Array;
  executionId: string;
  executionGeneration: number;
  attemptId: string;
  credentialHash: Uint8Array;
  credentialExpiresAt: Date;
  leaseExpiresAt: Date;
  now: Date;
};

export type ClaimResult =
  | { outcome: "claimed" | "replayed"; binding: WorkerBinding }
  // Unknown, expired, or presented for a different execution identity.
  | { outcome: "invalid_credential" }
  | { outcome: "no_session" };

export type ResolvedCredential =
  | { kind: "session"; attemptId: string; sessionId: string }
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
  | { outcome: "ok"; input: DeliveredInput | null; leaseExpiresAt: Date }
  | FenceRejection;

export type HeartbeatInput = {
  fence: WorkerFence;
  now: Date;
  leaseExpiresAt: Date;
  attemptState: AttemptState;
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
  | FenceRejection;

export type FinalizeInput = {
  fence: WorkerFence;
  now: Date;
  turnId: string;
  finalizeKey: string;
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
  resolveCredential(
    tokenHash: Uint8Array,
    now: Date,
  ): Promise<ResolvedCredential>;
  nextInputAtomic(input: NextInputInput): Promise<NextInputResult>;
  heartbeatAtomic(input: HeartbeatInput): Promise<HeartbeatResult>;
  commitEventsAtomic(input: CommitEventsInput): Promise<CommitEventsResult>;
  finalizeAtomic(input: FinalizeInput): Promise<FinalizeResult>;
  releaseAtomic(input: ReleaseInput): Promise<ReleaseResult>;
  // Called once the backend has observed the execution is gone; only then
  // does the session become claimable again and the launch slot return.
  confirmExecutionGoneAtomic(
    input: ConfirmExecutionGoneInput,
  ): Promise<ConfirmExecutionGoneResult>;
  countReservedSlots(partition?: string): Promise<number>;
}
