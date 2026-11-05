import type { EngineRule, SessionRuleUpdate } from "./driver.ts";

/** The part of the SDK's `PermissionUpdate` this module reads; only runtime.ts imports the SDK. */
type Suggestion = {
  type: string;
  behavior?: string;
  rules?: readonly { toolName: string; ruleContent?: string }[];
};

/**
 * The allow rules a person may be offered to keep for the session, taken
 * from the update suggestions the engine attached to a permission request.
 * Only `addRules` with `allow`, every rule of it for a tool the server
 * allowlist permits, is kept; a mode change, a directory, a deny or ask rule
 * and a rule for a tool outside the allowlist are dropped. A suggestion that
 * is only partly acceptable is dropped whole, so what a person agrees to is
 * never a subset of what the engine proposed.
 *
 * A Bash rule is also dropped unless it plainly covers the very call that is
 * asked about. The engine proposes `echo alpha *` for `echo alpha > a.txt`
 * and `cd sub *` for `cd sub && touch b`, and a rule installed from those
 * does not match the call, so the card would say "allowed for the session"
 * and the same call would be asked again. The SDK has no API that says
 * whether a rule matches, so this is a deliberately narrow filter: when it
 * is unsure it offers nothing. It never adds an offer or widens a rule.
 */
export function offerableRules(
  suggestions: readonly Suggestion[] | undefined,
  permittedTools: ReadonlySet<string>,
  call?: { tool: string; input: unknown },
): EngineRule[] {
  const kept: EngineRule[] = [];
  for (const suggestion of suggestions ?? []) {
    if (suggestion.type !== "addRules" || suggestion.behavior !== "allow") {
      continue;
    }
    const rules = suggestion.rules ?? [];
    if (rules.length === 0) continue;
    if (!rules.every((rule) => permittedTools.has(rule.toolName))) continue;
    if (
      call !== undefined &&
      !rules.every((rule) => coversCall(rule, call.tool, call.input))
    ) {
      continue;
    }
    for (const rule of rules) {
      const entry: EngineRule =
        rule.ruleContent === undefined
          ? { toolName: rule.toolName }
          : { toolName: rule.toolName, ruleContent: rule.ruleContent };
      if (!kept.some((have) => sameRule(have, entry))) kept.push(entry);
    }
  }
  return kept;
}

/** Shell syntax that makes one command line into more than one act. */
const SHELL_SYNTAX = /[|&;<>()$`\\\n\r*?]/;

/**
 * True when a Bash rule is the command itself or a prefix rule over a
 * command with no shell syntax. Other tools are not judged here.
 */
function coversCall(
  rule: { toolName: string; ruleContent?: string },
  tool: string,
  input: unknown,
): boolean {
  if (rule.toolName !== "Bash" || tool !== "Bash") return true;
  const command = (input as { command?: unknown } | null)?.command;
  const content = rule.ruleContent;
  if (typeof command !== "string" || content === undefined) return false;
  // The engine trims the command but keeps the rule as written, so padding on
  // either side can make an equal-looking pair miss.
  if (command !== command.trim() || content !== content.trim()) return false;
  if (SHELL_SYNTAX.test(command) && content !== command) return false;
  const prefix = /^(.*?)(?: \*|:\*)$/s.exec(content)?.[1];
  if (prefix === undefined) {
    // Exact rule: a `*` in it is a wildcard to the engine, not a literal.
    return content === command && !content.includes("*");
  }
  if (prefix === "" || prefix !== prefix.trim() || SHELL_SYNTAX.test(prefix)) {
    return false;
  }
  return command === prefix || command.startsWith(`${prefix} `);
}

/** What the engine gets back for an allow kept for the session. */
export function sessionRuleUpdate(
  rules: readonly EngineRule[],
): SessionRuleUpdate[] {
  return rules.length === 0
    ? []
    : [
        {
          type: "addRules",
          behavior: "allow",
          destination: "session",
          rules: rules.map((rule) => ({ ...rule })),
        },
      ];
}

/** True when both name the same rules, whatever their order. */
export function sameRules(
  left: readonly EngineRule[],
  right: readonly EngineRule[],
): boolean {
  // Both ways, so a repeated rule cannot stand in for a different one.
  return (
    left.every((rule) => right.some((other) => sameRule(rule, other))) &&
    right.every((rule) => left.some((other) => sameRule(rule, other)))
  );
}

function sameRule(left: EngineRule, right: EngineRule): boolean {
  return (
    left.toolName === right.toolName && left.ruleContent === right.ruleContent
  );
}
