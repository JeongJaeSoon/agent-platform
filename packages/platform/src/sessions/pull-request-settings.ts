import type { PullRequestSettings } from "@werft-ai/contracts";

/** An agent's own pull request settings; null where it has none saved. */
export type AgentPullRequestSettings = {
  formatting: "inherit" | "on" | "off";
  /** Markdown, or null. */
  template: string | null;
  /** A file of `PULL_REQUEST_TEMPLATE/`, for a repository that holds several. */
  templateName: string | null;
};

/** What a rendering is told, after the agent's settings met the workspace's. */
export type ResolvedPullRequestSettings = {
  sessionLink: "url" | "id";
  /** Whether the repository's own template is read at all. */
  readRepository: boolean;
  templateName: string | null;
  /**
   * The template the settings supply: used where the repository has none
   * (`repository_first`), or in its place (`override`). Null: the platform's
   * default. `layer` names whose it is, for the receipt.
   */
  text: { layer: "agent" | "workspace"; template: string } | null;
};

/**
 * One answer to how a pull request body is laid out (design pr-template 6).
 * The agent's setting wins over the workspace's; `formatting: off` leaves
 * every template out, so a structured field is still placed, on the
 * platform's default layout. Pure: the caller reads the two rows.
 */
export function resolvePullRequestSettings(
  workspace: PullRequestSettings,
  agent: AgentPullRequestSettings | null,
): ResolvedPullRequestSettings {
  const formatting =
    agent === null || agent.formatting === "inherit"
      ? workspace.formatting
      : agent.formatting;
  const sessionLink = workspace.session_link;
  if (formatting === "off") {
    return {
      sessionLink,
      readRepository: false,
      templateName: null,
      text: null,
    };
  }
  const text =
    agent?.template != null
      ? { layer: "agent" as const, template: agent.template }
      : workspace.default_template !== null
        ? { layer: "workspace" as const, template: workspace.default_template }
        : null;
  return {
    sessionLink,
    readRepository: workspace.template_mode === "repository_first",
    templateName: agent?.templateName ?? null,
    text,
  };
}
