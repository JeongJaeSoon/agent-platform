import type {
  AdmissionState,
  ControlAcceptedResponse,
  RecoveryDecisionRequest,
} from "@agent-platform/contracts";
import type { Principal } from "../authorization/policy.ts";

export type TerminateSessionInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  expectedRevision: number;
  reason: string | null;
  now: Date;
};

export type TerminateSessionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  // expected_revision does not match the row: the caller decided on a
  // state it no longer sees.
  | { outcome: "revision_conflict"; currentRevision: number }
  // A closed session has nothing left to terminate.
  | { outcome: "rejected"; admissionState: Extract<AdmissionState, "closed"> }
  // Bound through the legacy pod lifecycle, which has no kill path; the
  // command is refused rather than accepted on a promise nothing can keep.
  | { outcome: "unsupported" };

export type RecoveryDecisionInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  decision: RecoveryDecisionRequest;
  now: Date;
};

export type RecoveryDecisionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  | { outcome: "revision_conflict"; currentRevision: number }
  // A closed session takes no further decision.
  | { outcome: "rejected"; admissionState: Extract<AdmissionState, "closed"> }
  // abandon/confirm_completed while the previous execution is not yet
  // confirmed gone: the decision would race the exit observation.
  | { outcome: "execution_unconfirmed" }
  // The target turn is not one awaiting a decision; null when the session
  // has no such turn at all.
  | { outcome: "turn_not_unknown"; turnStatus: string | null }
  // Legacy pod binding: no execution to confirm gone, no kill path.
  | { outcome: "unsupported" };

export type ResumeSessionInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  expectedRevision: number;
  now: Date;
};

export type ResumeSessionResult =
  | { outcome: "accepted" | "replayed"; response: ControlAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  | { outcome: "revision_conflict"; currentRevision: number }
  // Nothing to resume from: closed, still active, or the pause family,
  // whose resume is 94S-138.
  | {
      outcome: "rejected";
      admissionState: Exclude<
        AdmissionState,
        "stopped" | "stopping" | "recovery_required"
      >;
    }
  // An unknown turn or an unconfirmed exit still needs an operator.
  | { outcome: "recovery_required"; unconfirmedTurnId: string | null }
  // No committed checkpoint to restore; the client closes or starts anew.
  | { outcome: "checkpoint_unavailable" }
  // Legacy pod binding, as for terminate.
  | { outcome: "unsupported" };

/**
 * api.md § 승인·중단·강제 종료: the terminate transaction blocks dispatch,
 * discards the epoch, cancels queued input, invalidates pending requests and
 * records the generation-specific kill intent. The kill itself happens
 * outside, and the receipt only succeeds once the execution is seen gone.
 */
export interface SessionControl {
  terminateAtomic(
    input: TerminateSessionInput,
  ): Promise<TerminateSessionResult>;
  /**
   * api.md § 최소 운영 복구: abandon, confirm_completed or close, decided
   * under the session lock against the operator's expected_revision, with
   * the receipt and audit event in the same transaction. No decision
   * dispatches anything: the operator resumes explicitly afterwards.
   */
  decideRecoveryAtomic(
    input: RecoveryDecisionInput,
  ): Promise<RecoveryDecisionResult>;
  /**
   * Resume from `stopped`: the session admits input again and, if input is
   * queued, is signalled for a new worker that restores the committed
   * checkpoint. Input cancelled by terminate stays cancelled.
   */
  resumeAtomic(input: ResumeSessionInput): Promise<ResumeSessionResult>;
}
