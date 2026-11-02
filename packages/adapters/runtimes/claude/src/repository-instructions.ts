import type { InstructionPart } from "@werft-ai/runtime-core";

import type { ClaudeRuntimeConfig } from "./config.ts";

/**
 * How an instruction part reads in the appended prompt: the platform's own
 * as it is, the agent's under a heading that says who wrote it. Part of the
 * fingerprint, so rewording the heading stops those sessions' checkpoints
 * from resuming.
 */
export function instructionText(part: InstructionPart): string {
  return part.scope === "agent"
    ? `Agent instructions set by this agent's administrators:\n\n${part.text}`
    : part.text;
}

/**
 * The text appended to the engine's preset system prompt: the caller's own
 * addition first, then the repository's instructions under a heading that
 * says where they came from.
 */
export function systemPromptAppend(
  config: Pick<
    ClaudeRuntimeConfig,
    "appendSystemPrompt" | "repositoryClaudeMd"
  >,
): string | undefined {
  const instructions = config.repositoryClaudeMd?.contents ?? null;
  const parts = [
    config.appendSystemPrompt,
    instructions === null || instructions.trim() === ""
      ? undefined
      : `Contents of CLAUDE.md at the root of the repository you are working in (project instructions checked into it):\n\n${instructions}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}
