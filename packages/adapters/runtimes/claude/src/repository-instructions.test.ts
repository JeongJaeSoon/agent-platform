import { describe, expect, test } from "bun:test";
import type {
  InstructionPart,
  RuntimeProfileInput,
} from "@werft-ai/runtime-core";

import { claudeProfileConfig } from "./contract.ts";
import { systemPromptAppend } from "./repository-instructions.ts";

describe("the appended system prompt of a profile", () => {
  const PLATFORM = "platform words";
  const REPO_HEADING =
    "Contents of CLAUDE.md at the root of the repository you are working in (project instructions checked into it):";
  const appended = (
    instructions: InstructionPart[],
    repoText: string | null = "repo rules",
  ) => {
    const profile: RuntimeProfileInput = {
      config: {
        cwd: "/workspace",
        home: "/home/worker",
        model: "claude-sonnet-5",
        permissionMode: "default",
        tools: ["Read"],
      },
      bindings: {
        principal: { ownerScope: "owner-a" },
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: {
            kind: "egress_token",
            token: "stand-in",
            transport: "http://egress-proxy.invalid",
          },
        },
      },
      bundle: {
        instructions,
        repoInstructions: { file: "CLAUDE.md", text: repoText },
        mcpServers: [],
      },
    };
    return systemPromptAppend(claudeProfileConfig(profile));
  };

  test("without agent instructions it is the platform's words and then the repository's, as before", () => {
    expect(appended([{ scope: "platform", text: PLATFORM }])).toBe(
      `${PLATFORM}\n\n${REPO_HEADING}\n\nrepo rules`,
    );
    expect(appended([])).toBe(`${REPO_HEADING}\n\nrepo rules`);
    expect(appended([], null)).toBeUndefined();
  });

  test("agent instructions come after the platform's words and before the repository's, under their heading", () => {
    expect(
      appended([
        { scope: "platform", text: PLATFORM },
        { scope: "agent", text: "Answer in haiku." },
      ]),
    ).toBe(
      `${PLATFORM}\n\nAgent instructions set by this agent's administrators:\n\nAnswer in haiku.\n\n${REPO_HEADING}\n\nrepo rules`,
    );
    expect(appended([{ scope: "agent", text: "Answer in haiku." }], null)).toBe(
      "Agent instructions set by this agent's administrators:\n\nAnswer in haiku.",
    );
  });
});

describe("systemPromptAppend", () => {
  test("adds nothing of the repository's unless the config lets it in", () => {
    expect(systemPromptAppend({})).toBeUndefined();
    expect(systemPromptAppend({ appendSystemPrompt: "platform" })).toBe(
      "platform",
    );
  });

  test("puts the caller's addition first and the repository's under its heading", () => {
    expect(
      systemPromptAppend({
        appendSystemPrompt: "platform",
        repositoryClaudeMd: { contents: "repo rules" },
      }),
    ).toBe(
      "platform\n\nContents of CLAUDE.md at the root of the repository you are working in (project instructions checked into it):\n\nrepo rules",
    );
  });

  test("an empty or missing file adds nothing", () => {
    expect(
      systemPromptAppend({ repositoryClaudeMd: { contents: null } }),
    ).toBeUndefined();
    expect(
      systemPromptAppend({ repositoryClaudeMd: { contents: "  \n" } }),
    ).toBeUndefined();
  });
});
