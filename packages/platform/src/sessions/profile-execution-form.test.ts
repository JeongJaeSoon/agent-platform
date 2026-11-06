import { describe, expect, test } from "bun:test";
import {
  profileExecutionForm,
  sameExecutionForm,
} from "./profile-execution-form.ts";

const base = {
  runtime_kind: "claude",
  runtime_version: "1.0.0",
  model: "m-a",
  tools: ["Read", "Bash"],
  permission_mode: "default",
  provider: { kind: "anthropic" },
};

describe("sameExecutionForm", () => {
  test("an omitted models list equals one that holds only the model", () => {
    expect(sameExecutionForm(base, { ...base, models: ["m-a"] })).toBe(true);
  });

  test("models are a set: order and the repeated default do not matter", () => {
    expect(
      sameExecutionForm(
        { ...base, models: ["m-b", "m-c"] },
        { ...base, models: ["m-c", "m-a", "m-b"] },
      ),
    ).toBe(true);
  });

  test("tools are sorted", () => {
    expect(sameExecutionForm(base, { ...base, tools: ["Bash", "Read"] })).toBe(
      true,
    );
  });

  test("defaults for billing, project settings and empty rule lists", () => {
    expect(
      sameExecutionForm(base, {
        ...base,
        provider: { kind: "anthropic", billing: "per_token" },
        project_settings: { claude_md: false },
        auto_mode_rules: [],
        title_model: undefined,
      }),
    ).toBe(true);
  });

  test("the repository mode is not part of the form", () => {
    expect(sameExecutionForm(base, { ...base, repository: "none" })).toBe(true);
  });

  test.each([
    ["model", { model: "m-b" }],
    ["title model", { title_model: "m-t" }],
    ["an extra allowed model", { models: ["m-a", "m-z"] }],
    ["a tool", { tools: ["Read"] }],
    ["billing", { provider: { kind: "anthropic", billing: "none" } }],
    ["claude_md", { project_settings: { claude_md: true } }],
    ["permission mode", { permission_mode: "plan" }],
    ["auto mode rules", { auto_mode_rules: ["allow x"] }],
  ])("a changed %s is a different form", (_name, change) => {
    expect(sameExecutionForm(base, { ...base, ...change })).toBe(false);
  });

  test("the form is a stable string", () => {
    expect(profileExecutionForm(base)).toBe(
      profileExecutionForm(JSON.parse(JSON.stringify(base))),
    );
  });
});
