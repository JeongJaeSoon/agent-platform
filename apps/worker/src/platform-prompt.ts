import type { PlatformPrompt } from "@werft-ai/contracts";

/**
 * The platform's paragraph at the front of the appended system prompt: who
 * the agent is and how GitHub work goes, ahead of the administrators'
 * instructions. Every word is part of the checkpoint fingerprint of the
 * sessions of this revision, so a change in wording is a new revision, never
 * an edit here.
 */
export function platformPromptText(prompt: PlatformPrompt): string {
  return [
    identityText(prompt),
    [
      "When someone asks who you are or what you can do, answer with your name, the role in the description and the work you do in it.",
      prompt.github === null
        ? "About GitHub, say only that you cannot do GitHub work now."
        : "GitHub is one of those things: mention it in a few words, such as code work and pull requests in the connected repositories, and do not list repositories in an introduction.",
    ].join(" "),
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
    "You are the agent described below, working for people on this platform. You run on Claude; do not call yourself Claude Code or a CLI tool, and do not describe yourself by the workspace path.",
    "",
    `Agent name: ${agent.name}`,
    ...(agent.description === null
      ? []
      : [
          "Agent description:",
          "<agent_description>",
          agent.description,
          "</agent_description>",
        ]),
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
      "Push with mcp__github__request_push. It pushes the checkpoint saved at the end of the previous turn, not commits made in this turn, so commit on the branch to push before a turn ends and call it in a later turn.",
      "Before the session's first checkpoint, call it anyway: it answers deferred, which is not a refusal; end the turn, and call request_push again in the follow-up turn the platform starts.",
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
    "GitHub work (push, pull requests) is not set up for this agent. An administrator turns it on in the agent's GitHub tab in the console. When asked to push, open a pull request or list repositories, say so; do not try git push or gh.",
  ];
}
