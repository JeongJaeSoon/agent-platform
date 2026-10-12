import type {
  ApiErrorCode,
  PushDecision,
  PushReceiptResult,
  PushRefusal,
  PushRequest,
  ReceiptActor,
} from "@agent-platform/contracts";

/** What every refused push operation answers, and its receipt records. */
export const PUSH_REFUSAL_ERRORS: Record<
  PushRefusal,
  { code: ApiErrorCode; message: string }
> = {
  missing_scope: {
    code: "FORBIDDEN",
    message: "This credential does not hold sessions:approve",
  },
  unverified_principal: {
    code: "FORBIDDEN",
    message:
      "A push decision needs a verified human credential: an API key or a signed-in user on an authenticating deployment",
  },
  not_found: { code: "NOT_FOUND", message: "Resource not found" },
  no_repository: {
    code: "PUSH_SOURCE_MISSING",
    message: "The session has no repository to push to",
  },
  no_checkpoint: {
    code: "PUSH_SOURCE_MISSING",
    message: "The session has no committed checkpoint to push",
  },
  checkpoint_unavailable: {
    code: "CHECKPOINT_UNAVAILABLE",
    message: "The session's latest checkpoint could not be verified",
  },
  request_open: {
    code: "PUSH_REQUEST_OPEN",
    message: "The session already has an open push request",
  },
  already_decided: {
    code: "PUSH_REQUEST_DECIDED",
    message: "The push request was already decided",
  },
  checkpoint_moved: {
    code: "CHECKPOINT_MOVED",
    message:
      "The session checkpointed again after the request pinned its commit; reject it and request a push of the new checkpoint",
  },
  commit_mismatch: {
    code: "CHECKPOINT_MOVED",
    message: "git_commit is not the commit this request pinned",
  },
};

export type PushOperation = "request_push" | "decide_push";

export type PushRefusalRecord = {
  ownerId: string;
  sessionId: string;
  actor: ReceiptActor;
  operation: PushOperation;
  refusal: PushRefusal;
  result: PushReceiptResult;
};

export type CreatePushRequestInput = {
  ownerId: string;
  sessionId: string;
  actor: ReceiptActor;
  idempotencyKey: string;
  payloadHash: string;
  repositoryId: string;
  checkpointRevision: number;
  gitCommit: string;
};

export type DecidePushRequestInput = {
  ownerId: string;
  sessionId: string;
  pushRequestId: string;
  actor: ReceiptActor;
  decision: PushDecision;
  gitCommit: string;
  reason: string | null;
  idempotencyKey: string;
  payloadHash: string;
};

export type PushWriteResult =
  | { outcome: "written" | "replayed"; request: PushRequest }
  | { outcome: "conflict" }
  // The receipt recording the refusal is already committed.
  | { outcome: "refused"; refusal: PushRefusal; receiptId: string };

/** An approved request the platform has taken to push. */
export type PushJob = {
  id: string;
  ownerId: string;
  sessionId: string;
  repositoryId: string;
  checkpointRevision: number;
  gitCommit: string;
  targetBranch: string;
};

export type PushOutcome =
  | { state: "pushed" }
  | { state: "failed"; error: { code: ApiErrorCode; message: string } };

export interface PushRequestStore {
  /** null when the session is not visible to the owner. */
  findSession(
    ownerId: string,
    sessionId: string,
  ): Promise<{ repositoryId: string | null } | null>;
  /** Writes the refusal receipt and returns its id. */
  recordRefusal(input: PushRefusalRecord): Promise<string>;
  /**
   * Pins the request in one transaction with its receipt. Refuses a session
   * that already has an open request or whose pointer moved off
   * `checkpointRevision` since the caller read it.
   */
  create(input: CreatePushRequestInput): Promise<PushWriteResult>;
  list(ownerId: string, sessionId: string): Promise<PushRequest[] | null>;
  get(
    ownerId: string,
    sessionId: string,
    pushRequestId: string,
  ): Promise<PushRequest | null>;
  /**
   * requested → approved | rejected. An approval is refused when the
   * session's checkpoint pointer no longer names the pinned revision; the
   * request then stays `requested`.
   */
  decide(input: DecidePushRequestInput): Promise<PushWriteResult>;
  /**
   * approved → pushing for the oldest approved request no one else holds,
   * or null. The pusher (94S-629) owns the row from here.
   */
  claimNextApproved(): Promise<PushJob | null>;
  /** pushing → pushed | failed, with a `push` receipt. False if not pushing. */
  finish(pushRequestId: string, outcome: PushOutcome): Promise<boolean>;
}
