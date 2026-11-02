import { z } from "zod";

import { type AgentGitHub, MCP_TOOL_PREFIX } from "../kollegium/agents.ts";
import {
  dispatchWorkflowRequestSchema,
  rerunWorkflowRequestSchema,
  submitPullRequestReviewRequestSchema,
} from "./github-work.ts";
import {
  commentPullRequestRequestSchema,
  openPullRequestRequestSchema,
  updatePullRequestRequestSchema,
} from "./pull-request.ts";
import {
  createPushRequestRequestSchema,
  pushRequestIdSchema,
} from "./push-request.ts";

/**
 * The built-in MCP server a session's agent reaches GitHub through (design
 * github-agent.md §3 "내장 MCP 서버 github"). A catalog MCP server may not
 * take this id.
 */
export const GITHUB_MCP_SERVER = "github";

const runIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Each tool's arguments: the session API's body plus what that API takes
 * from the path. Never a session id: the attempt token names the session.
 */
export const GITHUB_MCP_TOOL_ARGUMENTS = {
  request_push: createPushRequestRequestSchema,
  open_pull_request: openPullRequestRequestSchema.extend({
    push_request_id: pushRequestIdSchema,
  }),
  update_pull_request: updatePullRequestRequestSchema.safeExtend({
    push_request_id: pushRequestIdSchema,
  }),
  comment_pull_request: commentPullRequestRequestSchema.extend({
    push_request_id: pushRequestIdSchema,
  }),
  dispatch_workflow: dispatchWorkflowRequestSchema,
  get_workflow_run: z.object({ run_id: runIdSchema }).strict(),
  rerun_workflow: rerunWorkflowRequestSchema.extend({ run_id: runIdSchema }),
  submit_review: submitPullRequestReviewRequestSchema.safeExtend({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  list_repositories: z.object({}).strict(),
  attach_repository: z
    .object({ repository_id: z.string().min(1).max(128) })
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
 * or one the release allows that `attach_repository` would add
 * (`available`). `name` is the URL's path, never its credentials.
 */
export const LISTED_REPOSITORY_STATUS_VALUES = [
  "primary",
  "attached",
  "pending",
  "failed",
  "available",
] as const;

export const listedRepositorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  branch: z.string().nullable(),
  status: z.enum(LISTED_REPOSITORY_STATUS_VALUES),
});
export type ListedRepository = z.infer<typeof listedRepositorySchema>;

export const listRepositoriesResponseSchema = z.object({
  repositories: z.array(listedRepositorySchema),
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

/** The engine's names for them: `mcp__github__<tool>`. */
export function githubMcpToolNames(github: AgentGitHub): string[] {
  return githubMcpTools(github).map(
    (tool) => `${MCP_TOOL_PREFIX}${GITHUB_MCP_SERVER}__${tool}`,
  );
}
