import type {
  ApiErrorCode,
  PullRequest,
  PullRequestReceiptResult,
  PullRequestRefusal,
  PushRequestState,
  ReceiptActor,
} from "@werft-ai/contracts";
import { GITHUB_SETTINGS_UNSUPPORTED } from "./github-settings.ts";

/** What every refused pull request operation answers, and its receipt records. */
export const PULL_REQUEST_REFUSAL_ERRORS: Record<
  PullRequestRefusal,
  { code: ApiErrorCode; message: string }
> = {
  missing_scope: {
    code: "FORBIDDEN",
    message: "This credential does not hold sessions:approve",
  },
  unverified_principal: {
    code: "FORBIDDEN",
    message:
      "A pull request needs a verified human credential: an API key or a signed-in user",
  },
  not_found: { code: "NOT_FOUND", message: "Resource not found" },
  not_pushed: {
    code: "PUSH_NOT_PUSHED",
    message: "The push request has not been pushed",
  },
  catalog_changed: {
    code: "CATALOG_MISMATCH",
    message:
      "The catalog entry for the repository changed after the push request pinned it",
  },
  no_forge: {
    code: "FORBIDDEN",
    message:
      "The repository has no GitHub credential to open pull requests with",
  },
  no_pull_request: {
    code: "PULL_REQUEST_MISSING",
    message: "No pull request was opened from this push request",
  },
  forge_failed: {
    code: "BACKEND_UNAVAILABLE",
    message: "The repository host did not take the call",
  },
  github_settings_unsupported: GITHUB_SETTINGS_UNSUPPORTED,
};

export type PullRequestOperation = "open_pull_request" | "comment_pull_request";

/** The push request a pull request is opened from, as stored. */
export type PullRequestSource = {
  id: string;
  sessionId: string;
  repositoryId: string;
  /** Null on a request made before the binding was pinned. */
  repositoryBinding: string | null;
  state: PushRequestState;
  targetBranch: string;
  gitCommit: string;
};

export type PullRequestReceipt = {
  ownerId: string;
  sessionId: string;
  pushRequestId: string;
  actor: ReceiptActor;
  operation: PullRequestOperation;
  result: PullRequestReceiptResult;
};

export interface PullRequestStore {
  /** null when the owner has no such push request in the session. */
  findSource(
    ownerId: string,
    sessionId: string,
    pushRequestId: string,
  ): Promise<PullRequestSource | null>;
  findPullRequest(
    ownerId: string,
    pushRequestId: string,
  ): Promise<PullRequest | null>;
  /**
   * The latest pull request recorded for the session's branch, whichever of
   * its push requests opened it.
   */
  findBranchPullRequest(
    ownerId: string,
    sessionId: string,
    head: string,
  ): Promise<PullRequest | null>;
  /**
   * Writes the receipt and returns its id: `failed` with the refusal's
   * error when `result.refusal` is set, `succeeded` otherwise.
   */
  recordReceipt(input: PullRequestReceipt): Promise<string>;
  /**
   * Records the pull request opened from the push request, with its
   * `open_pull_request` receipt. When one is already recorded (a racing
   * call), keeps that one and the receipt says `created: false`.
   */
  savePullRequest(
    input: Omit<PullRequestReceipt, "operation" | "result"> & {
      repositoryId: string;
      number: number;
      url: string;
      head: string;
      base: string;
      created: boolean;
    },
  ): Promise<{ pullRequest: PullRequest; created: boolean; receiptId: string }>;
}
