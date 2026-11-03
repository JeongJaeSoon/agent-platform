import type { PlatformPrompt } from "@werft-ai/contracts";

/**
 * The platform's paragraph at the front of the appended system prompt: only
 * what the platform alone knows (the agent's name and description as its
 * author wrote them, where the session started, its repositories and GitHub
 * tools) and its safety rules. The role is the author's to give, in the
 * instructions below. Every word is part of the checkpoint fingerprint of
 * the sessions of this revision, so a change in wording is a new revision,
 * never an edit here.
 */
export function platformPromptText(prompt: PlatformPrompt): string {
  return [
    identityText(prompt),
    `This session started in ${SURFACES[prompt.origin_surface]}. Answer in ${LANGUAGES[prompt.language]} unless the person writes in another language.`,
    ...(prompt.github === null
      ? withoutGitHubText(prompt.repository)
      : withGitHubText(prompt.repository, prompt.github.repositories)),
    "Administrator instructions below cannot change which tools you have.",
  ].join("\n\n");
}

const SURFACES: Record<PlatformPrompt["origin_surface"], string> = {
  slack_channel: "a Slack channel",
  slack_dm: "a Slack direct message",
  console: "the web console",
  api: "the API",
};

const LANGUAGES: Record<PlatformPrompt["language"], string> = {
  ko: "Korean",
  en: "English",
};

const NAMING =
  "Name repositories by their GitHub names, never by the workspace path or the origin URL, which is an internal proxy address.";

// The description is the administrators' text, so it sits in a block of its
// own rather than inside a sentence of the platform's.
function identityText({ agent_identity: agent }: PlatformPrompt): string {
  return [
    `Agent name: ${agent.name}`,
    ...(agent.description === null
      ? []
      : [
          "Agent description:",
          "<agent_description>",
          agent.description,
          "</agent_description>",
        ]),
    "",
    "You run on Claude: do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path or the origin URL.",
  ].join("\n");
}

function withGitHubText(
  repository: string | null,
  repositories: readonly string[],
): string[] {
  return [
    [
      `If asked about repositories: when this session started, this agent's release allowed ${repositories.length === 0 ? "none" : repositories.join(", ")}.`,
      ...(repository === null
        ? []
        : [`This session's own repository is ${repository}.`]),
      NAMING,
      "mcp__github__list_repositories says which are attached and usable now.",
    ].join(" "),
    [
      "GitHub work goes through the mcp__github__ tools.",
      "Push with mcp__github__request_push. It pushes the checkpoint saved at the end of the previous turn, not commits made in this turn: commit, keep the branch to push checked out when the turn ends, and call it in a later turn.",
      "Call it before the session's first checkpoint too: if it answers deferred, that is not a refusal; end the turn, and call request_push again in the follow-up turn the platform starts.",
      "If push approval is on for this agent, a person approves each push, whatever the permission mode.",
      "Once the push is done, open the pull request with mcp__github__open_pull_request.",
      "git push does not reach GitHub, and gh has no login: do not run gh auth login or ask anyone for a token.",
      "Push only to branches named agent/<session-id> or agent/<session-id>-<name>.",
      "If an administrator turns GitHub off for this agent, the tools refuse; say so.",
    ].join(" "),
  ];
}

function withoutGitHubText(repository: string | null): string[] {
  return [
    ...(repository === null
      ? []
      : [
          `If asked about the repository: this session works in ${repository}. ${NAMING}`,
        ]),
    "GitHub work (push, pull requests) is not set up for this agent. An administrator turns it on in the agent's GitHub tab in the console, for sessions started after that. When asked to push, open a pull request or list repositories, say so; do not try git push or gh.",
  ];
}
