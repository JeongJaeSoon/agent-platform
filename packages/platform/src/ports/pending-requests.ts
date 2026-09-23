import type {
  PendingRequest,
  PendingSettlement,
  PostSessionAnswerRequest,
  ReceiptAcceptedResponse,
  RegisterPendingRequest,
} from "@agent-platform/contracts";
import type { Principal } from "../authorization/policy.ts";
import type { FenceRejection, WorkerFence } from "./worker-unit-of-work.ts";

export type AnswerRequestInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  answer: PostSessionAnswerRequest;
};

export type AnswerRequestResult =
  | { outcome: "accepted" | "replayed"; response: ReceiptAcceptedResponse }
  | { outcome: "conflict" | "not_found" }
  // Already answered, given up on by the worker, or past its expiry.
  | { outcome: "expired" }
  // The attempt that asked no longer owns the session, so its callback is
  // gone even if the row is still open.
  | { outcome: "stale" }
  // The answer names something the request never offered.
  | { outcome: "invalid"; reason: string };

/** The public half: what clients see and how they answer it. */
export interface PendingRequestStore {
  // null when the session is not visible to the owner.
  listOpen(
    ownerId: string,
    sessionId: string,
  ): Promise<PendingRequest[] | null>;
  answerAtomic(input: AnswerRequestInput): Promise<AnswerRequestResult>;
}

export type RegisterPendingInput = {
  fence: WorkerFence;
  turnId: string;
  requestId: string;
  inputHash: string;
  request: RegisterPendingRequest["request"];
  // A lifetime on the storage clock, never a caller deadline.
  ttlMs: number;
};

export type RegisterPendingResult =
  | {
      outcome: "registered" | "replayed";
      expiresAt: Date;
      expiresInMs: number;
    }
  | { outcome: "turn_not_found" }
  // The id is taken by a different request, or by this one after it closed.
  | { outcome: "conflict" }
  | FenceRejection;

export type DeliveredAnswer = {
  sequence: number;
  answer: PostSessionAnswerRequest;
  inputHash: string;
};

export type PendingControlInput = {
  fence: WorkerFence;
  answersAfter: number;
  settled: PendingSettlement[];
};

export type PendingControlResult =
  | { outcome: "ok"; answers: DeliveredAnswer[] }
  | FenceRejection;

/** The worker half, fenced like every other post-claim call. */
export interface WorkerPendingStore {
  registerAtomic(input: RegisterPendingInput): Promise<RegisterPendingResult>;
  pendingControlAtomic(
    input: PendingControlInput,
  ): Promise<PendingControlResult>;
  // A hint for heartbeat: an answer is waiting for this attempt to take it.
  hasUndelivered(fence: WorkerFence): Promise<boolean>;
}
