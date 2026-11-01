import type {
  ApiErrorCode,
  PushDecision,
  PushReasonCode,
  PushReceiptResult,
  PushRefusal,
  PushRequest,
  ReceiptActor,
} from "@werft-ai/contracts";
import { GITHUB_SETTINGS_UNSUPPORTED } from "./github-settings.ts";

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
  catalog_changed: {
    code: "CATALOG_MISMATCH",
    message:
      "The catalog entry for the repository changed after the request pinned it; request a push again",
  },
  target_refused: {
    code: "FORBIDDEN",
    message: "The platform pushes only to agent/<session-id>",
  },
  default_branch: {
    code: "FORBIDDEN",
    message: "The target is the repository's default branch",
  },
  non_fast_forward: {
    code: "REVISION_CONFLICT",
    message:
      "The remote branch holds a commit the pinned commit does not build on; the platform never force-pushes",
  },
  no_push_credential: {
    code: "FORBIDDEN",
    message: "The repository has no credential the platform can push with",
  },
  lease_expired: {
    code: "LEASE_EXPIRED",
    message: "The push was taken up and dropped too many times",
  },
  push_failed: {
    code: "BACKEND_UNAVAILABLE",
    message: "The repository host did not take the push",
  },
  github_settings_unsupported: GITHUB_SETTINGS_UNSUPPORTED,
  github_refused: {
    code: "GITHUB_REFUSED",
    message: "The GitHub gate refused the push",
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
  /** `repositoryBinding` of the catalog entry when the request was made. */
  repositoryBinding: string;
  checkpointRevision: number;
  gitCommit: string;
  /**
   * The release pushes without a person's approval: the request is approved
   * in the same transaction, decided by that release's policy.
   */
  approvedByRelease: string | null;
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
  /**
   * The session's last checkpoint as read before the decision; absent or
   * null when it was not read. An approval after the session checkpointed
   * again stands when the checkpoint is still this one and holds the pinned
   * commit.
   */
  latest?: { revision: number; gitCommit: string } | null;
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
  /** Null on a request made before the binding was pinned. */
  repositoryBinding: string | null;
  checkpointRevision: number;
  gitCommit: string;
  targetBranch: string;
  /** 1 on the first claim; each claim of an expired lease adds one. */
  attempt: number;
};

export type PushOutcome =
  | {
      state: "pushed";
      remoteUrl: string;
      remoteRef: string;
      /** What the remote ref held before, or null when it was created. */
      previousCommit: string | null;
    }
  | {
      state: "failed";
      refusal: PushRefusal;
      reasonCode?: PushReasonCode;
      /** Set once the remote is known, so the receipt can name it. */
      remoteUrl?: string;
      remoteRef?: string;
    };

export interface PushRequestStore {
  /** null when the session is not visible to the owner. */
  findSession(
    ownerId: string,
    sessionId: string,
  ): Promise<{
    repositoryId: string | null;
    /** The release, when it pins `github.push_approval: false`. */
    approvalOffRelease: string | null;
  } | null>;
  /** Writes the refusal receipt and returns its id. */
  recordRefusal(input: PushRefusalRecord): Promise<string>;
  /**
   * The answer an earlier create with this Idempotency-Key gave, or null when
   * the key is new. Lets a retry replay without re-reading the checkpoint.
   */
  replayCreate(input: {
    ownerId: string;
    sessionId: string;
    idempotencyKey: string;
    payloadHash: string;
  }): Promise<PushWriteResult | null>;
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
   * or a `pushing` one whose lease ran out (its pusher died), or null. The
   * claimer owns the row for `leaseMs`.
   */
  claimNextApproved(leaseMs: number): Promise<PushJob | null>;
  /**
   * pushing → pushed | failed, with a `push` receipt. False when the row is
   * no longer this attempt's: not pushing, or claimed again after its lease
   * ran out.
   */
  finish(
    job: Pick<PushJob, "id" | "attempt">,
    outcome: PushOutcome,
  ): Promise<boolean>;
}
