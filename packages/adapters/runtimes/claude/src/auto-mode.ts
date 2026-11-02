/**
 * The auto mode classifier's platform rules, handed to the engine as flag
 * settings: the engine reads `autoMode` only from user, flag and policy
 * settings, so a repository's `.claude/settings.json` cannot widen or drop
 * them. "$defaults" keeps the engine's own rules around them.
 */
export const PLATFORM_AUTO_MODE = {
  allow: [
    "$defaults",
    "Agent Platform Session Git Work: committing in this session's workspace, and the built-in `github` MCP server's tools for the session's own repository: `mcp__github__request_push` without a `repository_id` other than the session's own (the platform pushes only the session's last checkpoint, only to this session's branch `agent/<session-id>` or `agent/<session-id>-<branch>`, never forced), and `mcp__github__open_pull_request`, `mcp__github__update_pull_request` and `mcp__github__comment_pull_request` on the pull request opened from such a push. Also `mcp__github__list_repositories`, and `mcp__github__attach_repository` for a repository it listed (the platform fetches only repositories the release allows, read-only). Not covered: pushing to the default or a protected branch, force pushes or rewriting pushed history, merging or approving a pull request (`mcp__github__submit_review` on a pull request this session opened included), changing branch protection or repository settings, `mcp__github__request_push` with the `repository_id` of another or an attached repository, and secrets in commits, pull request text or comments.",
  ],
  environment: [
    "$defaults",
    "**Agent Platform session**: this workspace is an agent platform session. The session's repository, and any repository attached with `mcp__github__attach_repository`, is fetched read-only through the platform; `git push`, `gh` and direct GitHub API calls do not reach GitHub from here. Writes to GitHub go only through the built-in `github` MCP server, which pushes only to this session's own `agent/<session-id>` branches and applies the release's push approval on the server.",
  ],
} as const;
