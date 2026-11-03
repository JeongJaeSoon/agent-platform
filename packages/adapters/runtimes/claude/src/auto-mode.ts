/**
 * The auto mode classifier's platform rules, handed to the engine as flag
 * settings: the engine reads `autoMode` only from user, flag and policy
 * settings, so a repository's `.claude/settings.json` cannot widen or drop
 * them. "$defaults" keeps the engine's own rules around them.
 *
 * Each rule names a kind of action, not a tool; the environment entry is
 * where tool names map to those actions.
 */
export const PLATFORM_AUTO_MODE = {
  allow: [
    "$defaults",
    "Agent Platform Git Work: Committing changes in this session's workspace, and pushing them to GitHub through the platform's push flow, which pushes only this session's saved checkpoint to an agent work branch the platform created for this session, in this session's own repository. Not covered: pushing to the default branch, a protected branch or any branch the platform did not create for this session; force pushes or rewriting pushed history; pushing to any other repository, including one attached to this session to read; committing secrets or credentials.",
    "Agent Platform Pull Requests: Opening a pull request from such an agent work branch, and editing the title and description of, or commenting on, a pull request this session opened. Not covered: merging, approving or closing pull requests; submitting a review, including on a pull request this session opened; editing or commenting on pull requests this session did not open; secrets in pull request text or comments.",
    "Agent Platform Repository Reading: Listing the repositories the agent was granted, and attaching one of them to read its code. Not covered: writing to an attached repository.",
  ],
  soft_deny: [
    "$defaults",
    "Agent Platform GitHub Administration: changing repository settings, branch protection, webhooks, deploy keys or Actions secrets, deleting branches or repositories on GitHub, and merging pull requests, by any route.",
  ],
  environment: [
    "$defaults",
    "**Agent Platform session**: this workspace is an agent platform session. The session's repository, and any repository attached with `mcp__github__attach_repository`, is fetched read-only through the platform. `gh` is installed but has no GitHub login, and the GitHub API is outside the session's network: `git push`, `gh` and direct GitHub API calls do not reach GitHub from here. Writes to GitHub go only through the built-in `github` MCP server, which pushes only to this session's own `agent/<session-id>` branches and applies the release's push approval on the server. The platform's push flow is the built-in `github` MCP server: `request_push` pushes, `open_pull_request`, `update_pull_request` and `comment_pull_request` act on pull requests, `list_repositories` and `attach_repository` read repositories.",
  ],
} as const;
