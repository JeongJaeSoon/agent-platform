import { describe, expect, test } from "bun:test";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

import {
  offerableRules,
  sameRules,
  sessionRuleUpdate,
} from "./session-rules.ts";

const permitted = new Set(["Bash", "Read"]);
const allowBash: PermissionUpdate = {
  type: "addRules",
  behavior: "allow",
  destination: "localSettings",
  rules: [{ toolName: "Bash", ruleContent: "git status:*" }],
};

describe("offerableRules", () => {
  test("keeps an allow rule for a permitted tool, whatever destination the engine named", () => {
    expect(offerableRules([allowBash], permitted)).toEqual([
      { toolName: "Bash", ruleContent: "git status:*" },
    ]);
  });

  test("drops everything that is not an allow rule", () => {
    const dropped: PermissionUpdate[] = [
      { type: "setMode", mode: "bypassPermissions", destination: "session" },
      { ...allowBash, type: "replaceRules" },
      { ...allowBash, type: "removeRules" },
      { ...allowBash, behavior: "deny" },
      { ...allowBash, behavior: "ask" },
      {
        type: "addDirectories",
        directories: ["/etc"],
        destination: "session",
      },
    ];
    expect(offerableRules(dropped, permitted)).toEqual([]);
  });

  test("drops a suggestion with any rule outside the server allowlist, whole", () => {
    const mixed: PermissionUpdate = {
      ...allowBash,
      rules: [{ toolName: "Bash" }, { toolName: "WebFetch" }],
    };
    expect(offerableRules([mixed], permitted)).toEqual([]);
  });

  test("offers nothing without suggestions and counts a repeated rule once", () => {
    expect(offerableRules(undefined, permitted)).toEqual([]);
    expect(offerableRules([allowBash, allowBash], permitted)).toHaveLength(1);
  });
});

describe("offerableRules against the call being asked about", () => {
  const bashRule = (ruleContent: string): PermissionUpdate => ({
    type: "addRules",
    behavior: "allow",
    destination: "localSettings",
    rules: [{ toolName: "Bash", ruleContent }],
  });
  const offered = (command: string, ruleContent: string) =>
    offerableRules([bashRule(ruleContent)], permitted, {
      tool: "Bash",
      input: { command },
    });

  // Suggestions the engine really made (scripts/agent-sdk-compat), where the
  // rule did not cover the call and the same call was asked again.
  test.each([
    ["echo alpha > hello.txt", "echo alpha *"],
    ["echo alpha >> hello.txt", "echo alpha *"],
    ["cd sub && touch b.txt", "cd sub *"],
    ["echo a | tee out.txt", "echo a *"],
    ["make; rm x", "make *"],
    ["echo $(date)", "echo *"],
    ["git commit-tree HEAD", "git commit *"],
    ["git commit-tree HEAD", "git commit:*"],
    ["find . -name '*.tmp' -delete", "find . -name '*.tmp' -delete"],
    [" touch a", " touch a"],
    ["touch a ", "touch a "],
    ["\ttouch a", "\ttouch a"],
    [" touch a", " touch a:*"],
    ["touch a ", "touch a :*"],
  ])("offers nothing for %s with rule %s", (command, rule) => {
    expect(offered(command, rule)).toEqual([]);
  });

  test.each([
    ["touch a.txt", "touch a.txt"],
    ["git commit -m 'x y'", "git commit *"],
    ["git commit", "git commit *"],
    ["git commit -m x", "git commit:*"],
    ["FOO=1 npm test", "FOO=1 npm test"],
  ])("still offers %s with rule %s", (command, rule) => {
    expect(offered(command, rule)).toEqual([
      { toolName: "Bash", ruleContent: rule },
    ]);
  });

  test("a rule with a missing command or content is not offered", () => {
    expect(
      offerableRules([bashRule("ls *")], permitted, {
        tool: "Bash",
        input: {},
      }),
    ).toEqual([]);
    expect(
      offerableRules(
        [{ ...allowBash, rules: [{ toolName: "Bash" }] }],
        permitted,
        { tool: "Bash", input: { command: "ls" } },
      ),
    ).toEqual([]);
  });

  test("a rule for another tool is not judged by the command check", () => {
    const read: PermissionUpdate = {
      ...allowBash,
      rules: [{ toolName: "Read", ruleContent: "/a/**" }],
    };
    expect(
      offerableRules([read], permitted, {
        tool: "Read",
        input: { file_path: "/a/b" },
      }),
    ).toHaveLength(1);
  });
});

describe("sessionRuleUpdate", () => {
  test("always names the session as the destination", () => {
    expect(sessionRuleUpdate([{ toolName: "Read" }])).toEqual([
      {
        type: "addRules",
        behavior: "allow",
        destination: "session",
        rules: [{ toolName: "Read" }],
      },
    ]);
    expect(sessionRuleUpdate([])).toEqual([]);
  });
});

describe("sameRules", () => {
  test("compares as sets", () => {
    const a = { toolName: "Bash", ruleContent: "ls" };
    const b = { toolName: "Read" };
    expect(sameRules([a, b], [b, a])).toBe(true);
    expect(sameRules([a], [a, b])).toBe(false);
    expect(sameRules([a], [{ toolName: "Bash" }])).toBe(false);
    // A repeated rule is not a stand-in for a different one.
    expect(sameRules([a, a], [a, b])).toBe(false);
    expect(sameRules([a, b], [a, a])).toBe(false);
  });
});
