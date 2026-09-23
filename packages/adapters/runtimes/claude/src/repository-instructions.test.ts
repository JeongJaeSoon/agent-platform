import { describe, expect, test } from "bun:test";

import { systemPromptAppend } from "./repository-instructions.ts";

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
