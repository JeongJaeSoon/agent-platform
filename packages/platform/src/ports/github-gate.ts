import type {
  AgentGitHub,
  GitHubAppRole,
  GitHubCeiling,
  GitHubPurpose,
  GitHubRefusal,
  GitHubReviewEvent,
  ReceiptActor,
} from "@werft-ai/contracts";
import type {
  ForgeComment,
  ForgePullRequest,
  ForgeRepository,
  GitCredential,
  RepoRef,
} from "./forge.ts";

export type GitHubPermissions = Readonly<Record<string, "read" | "write">>;

/** One piece of a session's GitHub work, as a caller asks the gate for it. */
export type GitHubWork = {
  // The repository is never passed: the gate reads it off the session row.
  sessionId: string;
  purpose: GitHubPurpose;
  /** dispatch only: a branch name, never `refs/...`. */
  workflow?: { file: string; ref: string };
  /** rerun only: the gate finds its workflow and ref in github_workflow_dispatches. */
  runId?: number;
  /** review only: what a refusal's receipt names. */
  review?: { number: number; commitId: string; event: GitHubReviewEvent };
  /**
   * Who the receipts name. Absent: the human who started the session (a
   * clone has no caller). Null: no one (the push executor).
   */
  actor?: ReceiptActor | null;
};

export type GitHubWorkflowRun = {
  id: number;
  path: string;
  head_branch: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string;
};

/**
 * A failed call to GitHub. Carries GitHub's status and request id only:
 * never its message, which may echo what the request sent (dispatch inputs).
 */
export class GitHubCallError extends Error {
  override readonly name = "GitHubCallError";
  constructor(
    readonly what: string,
    readonly status: number | null,
    readonly requestId: string | null,
  ) {
    super(`GitHub ${what} failed${status === null ? "" : ` (${status})`}`);
  }
}

/** REST calls with the one credential a grant holds. */
export interface GitHubApi {
  /** Longest pull request or comment body GitHub takes. */
  readonly maxBodyLength: number;
  getRepository(): Promise<ForgeRepository>;
  findPullRequestForBranch(branch: string): Promise<ForgePullRequest | null>;
  createPullRequest(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<ForgePullRequest>;
  /** Reads the pull request's body and writes back what `edit` makes of it. */
  updatePullRequestBody(
    number: number,
    edit: (body: string) => string,
  ): Promise<void>;
  upsertComment(
    number: number,
    marker: string,
    body: string,
  ): Promise<ForgeComment>;
  /** `ref` is sent as `refs/heads/<ref>`. Null when GitHub names no run. */
  dispatchWorkflow(input: {
    workflow: string;
    ref: string;
    inputs: Readonly<Record<string, string>>;
  }): Promise<{ id: number; html_url: string } | null>;
  getWorkflowRun(runId: number): Promise<GitHubWorkflowRun>;
  rerunWorkflow(runId: number, failedOnly: boolean): Promise<void>;
  /** Always on `commitId`: GitHub files the review on that commit. */
  submitReview(input: {
    number: number;
    commitId: string;
    event: GitHubReviewEvent;
    body?: string;
  }): Promise<{ id: number; html_url: string }>;
}

/**
 * What a granted piece of work may call: one repository, one connection,
 * one credential the gate issued. Nothing here issues a credential.
 */
export interface GitHubGrant {
  readonly role: GitHubAppRole;
  readonly repo: RepoRef;
  readonly permissions: GitHubPermissions;
  /** For git over HTTP (clone, push). */
  readonly gitCredential: GitCredential;
  readonly api: GitHubApi;
  /** dispatch and rerun: the allow-list entry that matched. */
  readonly allowedBy: AgentGitHub["actions_allow"][number] | null;
  /** What the receipts of the work name. */
  readonly context: GitHubWorkContext;
}

export type GitHubWorkContext = {
  ownerId: string;
  sessionId: string;
  agentId: string | null;
  agentReleaseId: string | null;
  repositoryId: string;
};

/** A refusal before any GitHub call; its receipt is already written. */
export class GitHubGateError extends Error {
  override readonly name = "GitHubGateError";
  constructor(
    readonly reasonCode: GitHubRefusal,
    readonly receiptId: string | null,
  ) {
    super(`GitHub work refused: ${reasonCode}`);
  }
}

/**
 * The repository has a GitHub App or PAT behind it, but no credential could
 * be issued (no App registered, GitHub failing). The adapter logged why.
 */
export class GitHubUnavailableError extends Error {
  override readonly name = "GitHubUnavailableError";
  constructor(
    message: string,
    readonly receiptId: string | null = null,
  ) {
    super(message);
  }
}

export interface GitHubGate {
  /**
   * Null when the session's repository is not on GitHub (Gitea, a bearer
   * token, a public repository): the caller keeps the catalog's credential.
   * Refuses with GitHubGateError before any GitHub call.
   */
  grant(work: GitHubWork): Promise<GitHubGrant | null>;
}

/** What the gate reads of a session at every grant. */
export type GitHubSessionContext = {
  ownerId: string;
  sessionId: string;
  repositoryId: string | null;
  /** The URL and branch the session pinned at creation. */
  repository: { url: string; branch: string } | null;
  /** The human who started the session, for the receipts of clone. */
  startedBy: string | null;
  agent: {
    id: string;
    workspaceId: string;
    githubEnabled: boolean;
  } | null;
  release: {
    id: string;
    /** Absent: the release predates GitHub settings. "invalid": unparseable. */
    github: AgentGitHub | "invalid" | null;
  } | null;
  /** The agent workspace's ceiling; all false without a settings row. */
  ceiling: GitHubCeiling;
};

export type GitHubDispatchRecord = {
  runId: number;
  repositoryId: string;
  workflow: string;
  ref: string;
};

export type GitHubGateReceipt = {
  ownerId: string;
  sessionId: string;
  actor: ReceiptActor | null;
  operation:
    | "mint_github_token"
    | "dispatch_workflow"
    | "rerun_workflow"
    | "review_pull_request";
  status: "succeeded" | "failed";
  result: Record<string, unknown>;
  error: { code: "GITHUB_REFUSED"; message: string } | null;
};

export interface GitHubGateStore {
  context(sessionId: string): Promise<GitHubSessionContext | null>;
  findDispatch(
    repositoryId: string,
    runId: number,
  ): Promise<GitHubDispatchRecord | null>;
  recordReceipt(receipt: GitHubGateReceipt): Promise<string>;
}

/** A GitHub connection: one App (or PAT) and its own token cache. */
export interface GitHubConnection {
  readonly kind: "app" | "pat";
  /** False for a GHES `api_base`. */
  readonly githubCom: boolean;
  readonly appId: number | null;
  /**
   * A credential for one repository and permission set; `fresh` when it was
   * issued now rather than taken from the cache. GitHub refusing the
   * permissions is GitHubPermissionError.
   */
  credential(
    repo: RepoRef,
    permissions: GitHubPermissions,
  ): Promise<{ credential: GitCredential; fresh: boolean }>;
  /**
   * Whether the App is installed on `repo`, asked with its own JWT; null for
   * a PAT. Issues no installation token.
   */
  installed(repo: RepoRef): Promise<boolean | null>;
  api(repo: RepoRef, credential: GitCredential): GitHubApi;
}

/** GitHub refused to issue a token with the permissions asked (422). */
export class GitHubPermissionError extends Error {
  override readonly name = "GitHubPermissionError";
}

/** The connection of a catalog repository for `role`, or null. */
export type GitHubConnections = (
  repositoryId: string,
  role: GitHubAppRole,
) => GitHubConnection | null;
