import type {
  AdmissionState,
  ControlAcceptedResponse,
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
}
