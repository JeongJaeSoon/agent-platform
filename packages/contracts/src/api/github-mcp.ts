import { z } from "zod";

import { type AgentGitHub, MCP_TOOL_PREFIX } from "../kollegium/agents.ts";
import {
  ACTION_REFUSAL_CODES,
  type ActionRefusalCode,
  type ActionRefusalSpec,
  actionRefusalSpec,
  actionResultSchema,
} from "./action-broker.ts";
import {
  dispatchWorkflowRequestSchema,
  dispatchWorkflowResponseSchema,
  githubWorkflowRunSchema,
  rerunWorkflowRequestSchema,
  rerunWorkflowResponseSchema,
  submitPullRequestReviewRequestSchema,
  submitPullRequestReviewResponseSchema,
} from "./github-work.ts";
import {
  commentPullRequestRequestSchema,
  commentPullRequestResponseSchema,
  openPullRequestRequestSchema,
  openPullRequestResponseSchema,
  setPullRequestStateResponseSchema,
  updatePullRequestRequestSchema,
  updatePullRequestResponseSchema,
} from "./pull-request.ts";
import {
  createPushRequestRequestSchema,
  pushRequestIdSchema,
  pushRequestSchema,
} from "./push-request.ts";
import { githubPolicyReceiptFieldsSchema } from "./receipt.ts";

/**
 * The built-in MCP server a session's agent reaches GitHub through (design
 * github-agent.md §3 "내장 MCP 서버 github"). A catalog MCP server may not
 * take this id.
 */
export const GITHUB_MCP_SERVER = "github";

const runIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * The longest a waiting read may hold its answer. The built-in server is
 * served by the control host's authorizer listener, which keeps Bun's default
 * 10 second idle timeout. Bun checks it on a coarse timer, so the cut does
 * not land at 10: in a probe with the same `Bun.serve` options on Bun 1.3.14,
 * 32 of 32 silent calls were cut between 8.01 and 12.01 seconds after they
 * started. The wait is counted from the start of the call; the waiting itself
 * and the GitHub calls inside it are cut at that deadline. The database reads
 * around it keep their own pool timeouts, so the cap leaves about a second
 * below the earliest cut seen for them, the proxy and the answer; it is a
 * margin, not a guarantee.
 */
export const GITHUB_MCP_WAIT_SECONDS_MAX = 7;

const waitSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(GITHUB_MCP_WAIT_SECONDS_MAX)
  .optional();

/** `list_repositories` answers this many repositories a page unless asked for fewer. */
export const LIST_REPOSITORIES_LIMIT_DEFAULT = 100;
export const LIST_REPOSITORIES_LIMIT_MAX = 500;

/**
 * Each tool's arguments: the session API's body plus what that API takes
 * from the path. Never a session id: the attempt token names the session.
 */
export const GITHUB_MCP_TOOL_ARGUMENTS = {
  request_push: createPushRequestRequestSchema,
  open_pull_request: openPullRequestRequestSchema.safeExtend({
    push_request_id: pushRequestIdSchema,
  }),
  update_pull_request: updatePullRequestRequestSchema.safeExtend({
    push_request_id: pushRequestIdSchema,
  }),
  comment_pull_request: commentPullRequestRequestSchema.extend({
    push_request_id: pushRequestIdSchema,
  }),
  close_pull_request: z
    .object({ push_request_id: pushRequestIdSchema })
    .strict(),
  reopen_pull_request: z
    .object({ push_request_id: pushRequestIdSchema })
    .strict(),
  dispatch_workflow: dispatchWorkflowRequestSchema,
  get_workflow_run: z
    .object({ run_id: runIdSchema, wait_seconds: waitSecondsSchema })
    .strict(),
  rerun_workflow: rerunWorkflowRequestSchema.extend({ run_id: runIdSchema }),
  submit_review: submitPullRequestReviewRequestSchema.safeExtend({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  list_repositories: z
    .object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIST_REPOSITORIES_LIMIT_MAX)
        .optional(),
      cursor: z.string().min(1).max(256).optional(),
      query: z.string().min(1).max(128).optional(),
    })
    .strict(),
  attach_repository: z
    .object({
      repository_id: z.string().min(1).max(128),
      wait_seconds: waitSecondsSchema,
    })
    .strict(),
} as const;

export type GitHubMcpTool = keyof typeof GITHUB_MCP_TOOL_ARGUMENTS;

/** The release feature a tool needs; null for the default work. */
export const GITHUB_MCP_TOOL_FEATURES: Record<
  GitHubMcpTool,
  keyof AgentGitHub["features"] | null
> = {
  request_push: null,
  open_pull_request: null,
  update_pull_request: null,
  comment_pull_request: null,
  close_pull_request: null,
  reopen_pull_request: null,
  dispatch_workflow: "actions",
  get_workflow_run: "actions",
  rerun_workflow: "actions",
  submit_review: "review",
  list_repositories: null,
  attach_repository: null,
};

/**
 * One repository `list_repositories` names: the session's own (`primary`),
 * one on its attached list (`attached`, or the fetch's `pending`/`failed`),
 * one the release allows that `attach_repository` would add
 * (`available`), or one only the agent's active release allows, which the
 * session cannot attach because it stays on the release it started with
 * (`allowed_in_newer_release`). `name` is the URL's path, never its
 * credentials.
 */
export const LISTED_REPOSITORY_STATUS_VALUES = [
  "primary",
  "attached",
  "pending",
  "failed",
  "available",
  "allowed_in_newer_release",
] as const;

/**
 * `details.reason_code` of an `attach_repository` refused with
 * `GITHUB_REFUSED`: off the session's release, or off it but allowed by the
 * agent's active release (a new session can attach it; nothing needs to be
 * allowed again).
 */
export const REPOSITORY_ATTACH_REFUSAL_VALUES = [
  "repository_not_allowed",
  "allowed_in_newer_release",
] as const;
export type RepositoryAttachRefusal =
  (typeof REPOSITORY_ATTACH_REFUSAL_VALUES)[number];

export const listedRepositorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  branch: z.string().nullable(),
  status: z.enum(LISTED_REPOSITORY_STATUS_VALUES),
});
export type ListedRepository = z.infer<typeof listedRepositorySchema>;

export const listRepositoriesResponseSchema = z.object({
  repositories: z.array(listedRepositorySchema),
  /**
   * Pass it as `cursor` for the next page; null on the last. A call that
   * sends no `limit` or `cursor` gets the first page, so a caller from before
   * pages reads at most the first `LIST_REPOSITORIES_LIMIT_DEFAULT`.
   */
  next_cursor: z.string().nullable(),
});
export type ListRepositoriesResponse = z.infer<
  typeof listRepositoriesResponseSchema
>;

export const REPOSITORY_ATTACHMENT_STATUS_VALUES = [
  "pending",
  "attached",
  "failed",
] as const;

/**
 * Why a fetch the worker ran for an attachment ended without the remote:
 * over the time or size limit, or any other git failure.
 */
export const REPOSITORY_ATTACH_FAILURE_VALUES = [
  "fetch_timeout",
  "fetch_too_large",
  "fetch_failed",
] as const;
export const repositoryAttachFailureSchema = z.enum(
  REPOSITORY_ATTACH_FAILURE_VALUES,
);

/**
 * What `attach_repository` answers, and the `result` of its receipt.
 * `pending` while the worker has not reported the fetch yet; calling again
 * reads the same attachment. `already_attached` when the call changed
 * nothing: the session's own repository, one attached before, or a session
 * whose list is the release's whole list.
 */
export const repositoryAttachmentSchema = z.object({
  repository_id: z.string().min(1),
  status: z.enum(REPOSITORY_ATTACHMENT_STATUS_VALUES),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  failure: repositoryAttachFailureSchema.nullable(),
  already_attached: z.boolean(),
  receipt_id: z.string().nullable(),
});
export type RepositoryAttachment = z.infer<typeof repositoryAttachmentSchema>;

/**
 * What the MCP tool answers: the attachment and whether it can still change.
 * `final` is false only while `status` is `pending` at the end of the wait.
 */
export const waitedRepositoryAttachmentSchema =
  repositoryAttachmentSchema.safeExtend({ final: z.boolean() });

/**
 * What `get_workflow_run` answers: the run and whether it can still change.
 * `final` is true once GitHub reports it `completed`.
 */
export const waitedWorkflowRunSchema = githubWorkflowRunSchema.safeExtend({
  final: z.boolean(),
});
export type RepositoryAttachFailure = z.infer<
  typeof repositoryAttachFailureSchema
>;

/**
 * `result` of an `attach_repository` receipt: who asked from which attempt,
 * under which release, and what the worker fetched. `reason_code` is the
 * gate's refusal, as on the GitHub gate's own receipts.
 */
export const attachRepositoryReceiptResultSchema = z.object({
  session_id: z.string(),
  attempt_id: z.string(),
  agent_id: z.string().nullable(),
  agent_release_id: z.string().nullable(),
  repository_id: z.string(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  failure: repositoryAttachFailureSchema.nullable(),
  reason_code: z.string().nullable(),
  ...githubPolicyReceiptFieldsSchema.shape,
});

/**
 * The tools a release exposes, by the release's features alone. The server's
 * list, the egress check of a call and the worker's relay all read this.
 */
export function githubMcpTools(github: AgentGitHub): GitHubMcpTool[] {
  return (Object.keys(GITHUB_MCP_TOOL_FEATURES) as GitHubMcpTool[]).filter(
    (tool) => {
      const feature = GITHUB_MCP_TOOL_FEATURES[tool];
      return feature === null || github.features[feature];
    },
  );
}

/**
 * The tools an `agent` session always sees, whatever its settings say now:
 * its runtime config, and so its checkpoint fingerprint, must not follow a
 * change to them. Each call is judged instead.
 */
export const GITHUB_MCP_FIXED_TOOLS = Object.keys(
  GITHUB_MCP_TOOL_FEATURES,
) as GitHubMcpTool[];

/**
 * What each tool does, in terms of its fields. Never an instruction to the
 * model: what to do next is the model's call, and what a refusal means is
 * its code.
 */
export const GITHUB_MCP_TOOL_DESCRIPTIONS: Record<GitHubMcpTool, string> = {
  request_push:
    "Request a push of the session's last checkpoint (the state at the end of the previous turn) to branch agent/<session-id>, or agent/<session-id>-<branch> when `branch` is given. `repository_id` names an attached repository; omitted, the session's own. Returns the push request, which waits for a person when the release requires approval, or `deferred` when no checkpoint exists yet.",
  open_pull_request:
    "Open, or return the already open, pull request from the branch and commit of a pushed push request (`push_request_id`). Content fields: `title`; `summary` (what changed and why, a few sentences); `changes` (one change per item); `rationale` (the reason for the change); `testing` (how it was checked); `notes` (what a reviewer needs to know); `related` (issues: `number`, optional `repository_id`, `closes` to close it on merge). `body` is the legacy single text and cannot be combined with the fields above.",
  update_pull_request:
    "Set the title or the content of the pull request that the push request's branch has open. Given any of `summary`, `changes`, `rationale`, `testing`, `notes` or `related`, the body is written again from those fields (a field left out is empty); `body` (legacy) replaces the body as text; `title` alone leaves the body. The platform's closing lines stay, naming the push request's commit.",
  comment_pull_request:
    "Add a comment to the pull request of a pushed push request. The same `marker` edits the same comment.",
  close_pull_request:
    "Close the pull request of a pushed push request without merging it; the branch stays. `changed` is false when it was already closed.",
  reopen_pull_request:
    "Reopen the closed pull request of a pushed push request. `changed` is false when it was already open.",
  dispatch_workflow:
    "Dispatch an allow-listed workflow on a branch. `inputs` go to GitHub only.",
  get_workflow_run: `Read a workflow run of the session's repository. \`wait_seconds\` (0 to ${GITHUB_MCP_WAIT_SECONDS_MAX}, default 0) holds the answer until the run is \`completed\` or the seconds have passed. \`final\` is true when the run is \`completed\`, false when it was still running at the end of the wait.`,
  rerun_workflow:
    "Rerun a workflow run that the platform dispatched for the session's repository.",
  submit_review:
    "Submit a review of a pull request as the reviewer App, on the commit named by `commit_id`.",
  list_repositories: `List the repositories the session can work on, ${LIST_REPOSITORIES_LIMIT_DEFAULT} a page. The session's own comes first on the first page and is not counted in \`limit\` (1 to ${LIST_REPOSITORIES_LIMIT_MAX}); the others are in id order. \`next_cursor\` is non-null when more follow: send it back as \`cursor\`. \`query\` keeps those whose id or name contains it. \`status\` is \`primary\` (the session's own), \`attached\`, \`pending\` or \`failed\` (fetch in progress or failed), \`available\` (attach_repository would add it) or \`allowed_in_newer_release\` (only the agent's current release allows it).`,
  attach_repository: `Attach a repository the release allows to the session as a git remote named \`repository_id\`, with its default branch fetched to \`<repository_id>/<branch>\`. \`status\` is \`pending\` while the fetch runs. \`wait_seconds\` (0 to ${GITHUB_MCP_WAIT_SECONDS_MAX}, default 0) holds the answer until the fetch ends or the seconds have passed; \`final\` is false when the fetch was still running at the end of the wait. Attaching an attached repository changes nothing.`,
};

const requestPushResultSchema = z.union([
  pushRequestSchema,
  // The release's settings keep the follow-up turn (`push_continuations`):
  // no checkpoint yet, the push request is made one turn later.
  z
    .object({
      status: z.literal("deferred"),
      continuation: z.literal("after_turn"),
    })
    .strict(),
]);

/** The envelope each tool answers with, as `outputSchema` states it. */
export const GITHUB_MCP_TOOL_OUTPUTS = {
  request_push: actionResultSchema(requestPushResultSchema),
  open_pull_request: actionResultSchema(openPullRequestResponseSchema),
  update_pull_request: actionResultSchema(updatePullRequestResponseSchema),
  comment_pull_request: actionResultSchema(commentPullRequestResponseSchema),
  close_pull_request: actionResultSchema(setPullRequestStateResponseSchema),
  reopen_pull_request: actionResultSchema(setPullRequestStateResponseSchema),
  dispatch_workflow: actionResultSchema(dispatchWorkflowResponseSchema),
  get_workflow_run: actionResultSchema(waitedWorkflowRunSchema),
  rerun_workflow: actionResultSchema(rerunWorkflowResponseSchema),
  submit_review: actionResultSchema(submitPullRequestReviewResponseSchema),
  list_repositories: actionResultSchema(listRepositoriesResponseSchema),
  attach_repository: actionResultSchema(waitedRepositoryAttachmentSchema),
} as const satisfies Record<GitHubMcpTool, z.ZodType>;

const COMMON_REFUSALS = [
  "validation_error",
  "internal_error",
  "forbidden",
  "github_disabled",
  "feature_off",
] as const satisfies readonly ActionRefusalCode[];

const PULL_REQUEST_REFUSALS = [
  ...COMMON_REFUSALS,
  "missing_scope",
  "unverified_principal",
  "not_found",
  "not_pushed",
  "push_rejected",
  "push_failed",
  "catalog_changed",
  "no_forge",
  "github_settings_unsupported",
  "github_refused",
  "forge_failed",
  "backend_unavailable",
] as const satisfies readonly ActionRefusalCode[];

const GITHUB_WORK_REFUSALS = [
  ...COMMON_REFUSALS,
  "not_found",
  "github_refused",
  "backend_unavailable",
] as const satisfies readonly ActionRefusalCode[];

/**
 * The codes a tool can refuse with (catalog 5.5 to 5.7). A refusal of a
 * tool carries the `by` and `retryable` its code fixes in
 * `ACTION_REFUSAL_CODES`, unless `GITHUB_MCP_REFUSAL_OVERRIDES` says
 * otherwise for that tool.
 */
export const GITHUB_MCP_TOOL_REFUSALS: Record<
  GitHubMcpTool,
  readonly ActionRefusalCode[]
> = {
  request_push: [
    ...COMMON_REFUSALS,
    "missing_scope",
    "unverified_principal",
    "not_found",
    "no_repository",
    "repository_not_allowed",
    "no_checkpoint",
    "checkpoint_unavailable",
    "request_open",
    "catalog_changed",
    "default_branch",
    "target_refused",
    "attribution_mismatch",
    "uncommitted_changes",
    "github_settings_unsupported",
    "github_refused",
    "backend_unavailable",
  ],
  open_pull_request: PULL_REQUEST_REFUSALS,
  update_pull_request: [...PULL_REQUEST_REFUSALS, "no_pull_request"],
  comment_pull_request: [...PULL_REQUEST_REFUSALS, "no_pull_request"],
  close_pull_request: [
    ...PULL_REQUEST_REFUSALS,
    "no_pull_request",
    "pull_request_merged",
  ],
  reopen_pull_request: [
    ...PULL_REQUEST_REFUSALS,
    "no_pull_request",
    "pull_request_merged",
  ],
  dispatch_workflow: GITHUB_WORK_REFUSALS,
  get_workflow_run: GITHUB_WORK_REFUSALS,
  rerun_workflow: GITHUB_WORK_REFUSALS,
  submit_review: [...GITHUB_WORK_REFUSALS, "stale_commit"],
  list_repositories: GITHUB_WORK_REFUSALS,
  attach_repository: [
    ...GITHUB_WORK_REFUSALS,
    "repository_not_allowed",
    "allowed_in_newer_release",
  ],
};

/**
 * A pull request tool reads a push request that failed as final (catalog
 * 5.6); the same code on `request_push` is a push that can be tried again.
 */
export const GITHUB_MCP_REFUSAL_OVERRIDES: Partial<
  Record<GitHubMcpTool, Partial<Record<ActionRefusalCode, ActionRefusalSpec>>>
> = {
  open_pull_request: { push_failed: actionRefusalSpec("platform") },
  update_pull_request: { push_failed: actionRefusalSpec("platform") },
  comment_pull_request: { push_failed: actionRefusalSpec("platform") },
  // The service answers a GitHub outage and a permanent refusal of the state
  // change (a pull request merged between its read and its PATCH) with the
  // same `forge_failed`, so a retry cannot be promised.
  close_pull_request: {
    push_failed: actionRefusalSpec("platform"),
    forge_failed: actionRefusalSpec("github"),
  },
  reopen_pull_request: {
    push_failed: actionRefusalSpec("platform"),
    forge_failed: actionRefusalSpec("github"),
  },
};

/** The `by` and `retryable` of a tool's code, or null if it has no such code. */
export function githubMcpRefusalSpec(
  tool: GitHubMcpTool,
  code: unknown,
): ActionRefusalSpec | null {
  if (typeof code !== "string") return null;
  if (!(GITHUB_MCP_TOOL_REFUSALS[tool] as readonly string[]).includes(code)) {
    return null;
  }
  return (
    GITHUB_MCP_REFUSAL_OVERRIDES[tool]?.[code as ActionRefusalCode] ??
    ACTION_REFUSAL_CODES[code as ActionRefusalCode]
  );
}

/** The engine's names for them: `mcp__github__<tool>`. */
export function githubMcpToolNames(tools: readonly GitHubMcpTool[]): string[] {
  return tools.map((tool) => `${MCP_TOOL_PREFIX}${GITHUB_MCP_SERVER}__${tool}`);
}
