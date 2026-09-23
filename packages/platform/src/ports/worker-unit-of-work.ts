import type {
  ApiErrorCode,
  AttemptState,
  CheckpointBlockReason,
  CheckpointRef,
  ExecutionBackend,
  FinalizeRequest,
  PauseBlockedReason,
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

// A profile and repository this host may run together, with the URL and
// branch the repository is registered under now. A session binds only when
// its row matches one exactly: a host that does not know the profile cannot
// pick the runtime, a pair the repository no longer allows must not carry
// the profile's trust to it (94S-258), and a repository id re-pointed at
// another URL must not carry the old grant to the new one.
export type RunnablePair = {
  profileId: string;
  repositoryId: string;
  url: string;
  branch: string;
};

export type ClaimInput = {
  runnable: RunnablePair[];
  // A session that has spent this much is not bound: it would only be told
  // to release again at its first nextInput (94S-131).
  costLimitUsd: number;
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
  // The session's last ran turn has no trusted checkpoint covering it
  // (94S-288). Nothing was bound: the session went to recovery_required in
  // the same transaction and the launch was asked to go.
  | { outcome: "context_gap" }
  | { outcome: "no_session" };

// The fence as it stood when the token was issued. A request body may not
// name any other one: the numbers are guessable, so without this a holder of
// a token that is about to be revoked could pre-address the next revision.
export type ResolvedCredential =
  | ({ kind: "session" } & WorkerFence)
  // A launch nonce: valid only for bootstrapClaim.
  | { kind: "bootstrap" }
  | null;

export type NextInputInput = {
  fence: WorkerFence;
  now: Date;
  // A session that has spent this much is handed no new turn (94S-131).
  costLimitUsd: number;
};
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
      /**
       * Nothing new will come for a reason outside the attempt: the session
       * has spent its budget. The worker should release its slot.
       */
      blocked?: "BUDGET_EXCEEDED";
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
  // The verifier's verdict on `checkpoint`, never the worker's say.
  checkpointVersionsHeld?: boolean;
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
  // carries a blocking pending reason: the turn cannot be reported as durably
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
  // A reason to record (durability.ts checkpointPendingReason); undefined
  // leaves the stored one alone, and an advisory reason never replaces a
  // blocking one. Only a committed checkpoint clears it (finalizeAtomic /
  // commitAtomic).
  pendingReason?: CheckpointBlockReason;
};
export type CheckpointStateResult =
  | {
      outcome: "ok";
      // The pointer from the same snapshot as the fence; the protocol works
      // from this rather than re-reading it unfenced.
      pointer: CheckpointPointer | null;
      // Whether that pointer may be restored from (hasRestorePoint): not
      // under a blocking reason, and not retired by a start_fresh decision
      // (94S-288). The next revision still counts from `pointer` either way.
      restorable: boolean;
      pendingReason: CheckpointBlockReason | null;
    }
  | FenceRejection;

/**
 * What a served restore plan was built on (94S-204). `fallback` is set when
 * the plan restores an earlier revision because the pointer's checkpoint was
 * damaged, and null when it restores the pointer itself.
 */
export type RestoreBaseInput = {
  fence: WorkerFence;
  now: Date;
  /** The pointer revision the plan was judged against. */
  pointerRevision: number;
  fallback: {
    revision: number;
    skipped: readonly { reason: string; revision: number }[];
  } | null;
};
export type RestoreBaseResult =
  | { outcome: "ok" }
  // The pointer is no longer the one the plan was judged against.
  | { outcome: "pointer_moved"; currentRevision: number | null }
  // This attempt was already handed a different revision, the pointer's or
  // an earlier one, for the same pointer; it must not restore two.
  | { outcome: "base_changed"; recordedRevision: number }
  | FenceRejection;

export type ReleaseInput = {
  fence: WorkerFence;
  now: Date;
  reason: string;
  /**
   * Set when the release answers a pause: the attempt drained and asks the
   * coordinator to commit the pause. It is refused, and the attempt keeps
   * its lease and engine, unless the pause can be committed now.
   */
  pauseControlId?: string;
};
export type ReleaseResult =
  | { released: boolean }
  // The pause it answers is no longer the session's open one.
  | { released: false; refused: "pause_stale" }
  // Not at a safe boundary: the checkpoint the pause needs is not there.
  | { released: false; refused: "pause_blocked"; reason: PauseBlockedReason }
  | { released: false; refused: "lease_expired" };

export type ReadyInput = {
  fence: WorkerFence;
  now: Date;
  /** The checkpoint revision the worker restored (its claim's); null when it started fresh. */
  restoredRevision: number | null;
};
export type ReadyResult =
  // `activated` when this report completed a resume from `paused`.
  | { outcome: "ok"; activated: boolean }
  // A resuming session whose trusted pointer is not what the worker
  // restored: the resume is failed and the session left to an operator.
  | { outcome: "restore_mismatch" }
  | FenceRejection;

export type FailResumeInput = {
  fence: WorkerFence;
  now: Date;
  /** The pointer revision the restore verdict was reached on. */
  pointerRevision: number | null;
  error: { code: ApiErrorCode; message: string };
};
export type FailResumeResult =
  // `failed` when the session was still resuming from that pointer.
  { outcome: "ok"; failed: boolean } | FenceRejection;

/**
 * Which resource a caller saw go, told apart from any other built for the
 * same launch: the fingerprint of the bootstrap credential it was created
 * with (`launchNonceFingerprint`; null for none). Every create issues a new
 * credential before the resource exists and a claim keeps it, so the launch
 * row names its current incarnation before a worker can bind to it, and no
 * later write by a stale observer can put an old one back.
 *
 * A fingerprint read off the resource itself is that resource. One read off
 * the launch row is only what the row meant to run: a create may have issued
 * it and not yet built anything, so a caller that saw nothing also says
 * whether the launch was `claimed` — a worker that bound since is bound to
 * something the caller never saw.
 */
export type ExecutionIncarnation = {
  nonceFingerprint: string | null;
  claimed?: boolean;
};

export type ConfirmExecutionGoneInput = {
  executionId: string;
  now: Date;
  /**
   * Given, the confirmation holds only while the launch still names this
   * incarnation. A scheduler pass that lost its lock can have watched an old
   * resource go while another pass built a replacement a worker has since
   * bound; confirming that would hand back the new binding and its slot.
   * The gateway leaves it out: it speaks for the attempt it fenced.
   */
  incarnation?: ExecutionIncarnation;
};
export type ConfirmExecutionGoneResult = {
  sessionReleased: boolean;
  slotReleased: boolean;
  /** Present when `incarnation` no longer matched; nothing was changed. */
  superseded?: true;
  /**
   * Present when a replacement is pending and nothing was changed: the
   * resource being gone is the rebuild in progress, not an exit.
   */
  deferred?: true;
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
  // Records which revision a restore plan hands the attempt, before the
  // plan is returned: a fallback is written to the session and announced on
  // its event stream, and a plan on the pointer clears an earlier fallback.
  recordRestoreBaseAtomic(input: RestoreBaseInput): Promise<RestoreBaseResult>;
  releaseAtomic(input: ReleaseInput): Promise<ReleaseResult>;
  // The attempt restored what its claim named and its engine loaded it.
  // For a `resuming` session that completes the resume: active, and the
  // resume receipt succeeds. Any other session is left as it is.
  readyAtomic(input: ReadyInput): Promise<ReadyResult>;
  // A restore verdict that refuses the checkpoint a resuming session was
  // resumed onto: recovery_required, and the resume receipt fails with it.
  failResumeAtomic(input: FailResumeInput): Promise<FailResumeResult>;
  // Called once the backend has observed the execution is gone; only then
  // does the session become claimable again and the launch slot return.
  confirmExecutionGoneAtomic(
    input: ConfirmExecutionGoneInput,
  ): Promise<ConfirmExecutionGoneResult>;
  countReservedSlots(partition?: string): Promise<number>;
}
