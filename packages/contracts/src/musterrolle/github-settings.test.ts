import { describe, expect, test } from "bun:test";
import { pullRequestTemplateNameSchema } from "./github-settings.ts";

describe("a pull request template name", () => {
  test("is printable text, one to 100 characters", () => {
    expect(
      pullRequestTemplateNameSchema.safeParse("bug_report.md").success,
    ).toBe(true);
    expect(pullRequestTemplateNameSchema.safeParse("").success).toBe(false);
    expect(
      pullRequestTemplateNameSchema.safeParse("a".repeat(101)).success,
    ).toBe(false);
    expect(pullRequestTemplateNameSchema.safeParse("a\u0000.md").success).toBe(
      false,
    );
  });

  test("refuses a lone surrogate, which the receipt's jsonb cannot hold, and keeps a pair", () => {
    expect(pullRequestTemplateNameSchema.safeParse("\ud800.md").success).toBe(
      false,
    );
    expect(pullRequestTemplateNameSchema.safeParse("🚀.md").success).toBe(true);
  });
});
