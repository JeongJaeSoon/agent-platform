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
  // The turn has an interrupt waiting on it: nothing new may hold it open.
  | { outcome: "turn_interrupted" }
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

/**
 * A control intent the attempt owes an answer to. An interrupt names its
 * turn (the public turn id); a pause names none: it asks the attempt to
 * finish the one it has and take no other, and its id is the pause receipt's.
 */
export type DeliveredControl =
  | { controlId: string; kind: "interrupt"; turnId: string; issuedAt: Date }
  | { controlId: string; kind: "pause"; turnId: null; issuedAt: Date };

export type PendingControlResult =
  | {
      outcome: "ok";
      answers: DeliveredAnswer[];
      control: DeliveredControl | null;
    }
  | FenceRejection;

/** The worker half, fenced like every other post-claim call. */
export interface WorkerPendingStore {
  registerAtomic(input: RegisterPendingInput): Promise<RegisterPendingResult>;
  pendingControlAtomic(
    input: PendingControlInput,
  ): Promise<PendingControlResult>;
  // A hint for heartbeat: an answer or a control intent is waiting for this
  // attempt to take it.
  hasUndelivered(fence: WorkerFence): Promise<boolean>;
}
