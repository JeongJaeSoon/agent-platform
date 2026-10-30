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
} from "./pull-request.ts";
import { pushRequestIdSchema } from "./push-request.ts";

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
  request_push: z.object({}).strict(),
  open_pull_request: openPullRequestRequestSchema.extend({
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
} as const;

export type GitHubMcpTool = keyof typeof GITHUB_MCP_TOOL_ARGUMENTS;

/** The release feature a tool needs; null for the default work. */
export const GITHUB_MCP_TOOL_FEATURES: Record<
  GitHubMcpTool,
  keyof AgentGitHub["features"] | null
> = {
  request_push: null,
  open_pull_request: null,
  comment_pull_request: null,
  dispatch_workflow: "actions",
  get_workflow_run: "actions",
  rerun_workflow: "actions",
  submit_review: "review",
};

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
