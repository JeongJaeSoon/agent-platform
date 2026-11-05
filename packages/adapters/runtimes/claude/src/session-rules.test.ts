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
  });
});
