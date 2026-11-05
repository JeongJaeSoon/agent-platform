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
 */
export function offerableRules(
  suggestions: readonly Suggestion[] | undefined,
  permittedTools: ReadonlySet<string>,
): EngineRule[] {
  const kept: EngineRule[] = [];
  for (const suggestion of suggestions ?? []) {
    if (suggestion.type !== "addRules" || suggestion.behavior !== "allow") {
      continue;
    }
    const rules = suggestion.rules ?? [];
    if (rules.length === 0) continue;
    if (!rules.every((rule) => permittedTools.has(rule.toolName))) continue;
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
  return (
    left.length === right.length &&
    left.every((rule) => right.some((other) => sameRule(rule, other)))
  );
}

function sameRule(left: EngineRule, right: EngineRule): boolean {
  return (
    left.toolName === right.toolName && left.ruleContent === right.ruleContent
  );
}
