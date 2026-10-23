import { describe, expect, test } from "bun:test";
import {
  SESSION_TITLE_MAX_GRAPHEMES,
  sessionTitleSchema,
  titleGraphemes,
} from "@werft-ai/contracts";
import { deriveSessionTitle } from "./session-title.ts";

describe("deriveSessionTitle", () => {
  test("keeps a short message as it is", () => {
    expect(deriveSessionTitle("Fix the flaky checkout test")).toBe(
      "Fix the flaky checkout test",
    );
  });

  test("collapses line breaks, tabs and runs of spaces and trims the ends", () => {
    expect(
      deriveSessionTitle("  \n\tFix the\r\n\r\nflaky   checkout test \n"),
    ).toBe("Fix the flaky checkout test");
  });

  test("is null for a message of only whitespace", () => {
    expect(deriveSessionTitle(" \n\t　 ")).toBeNull();
    expect(deriveSessionTitle("")).toBeNull();
  });

  test("keeps exactly the limit uncut", () => {
    const text = "a".repeat(SESSION_TITLE_MAX_GRAPHEMES);
    expect(deriveSessionTitle(text)).toBe(text);
  });

  test("cuts a longer one to the limit, ellipsis included", () => {
    const title = deriveSessionTitle("b".repeat(500));
    expect(title).toBe(`${"b".repeat(SESSION_TITLE_MAX_GRAPHEMES - 1)}…`);
    expect(titleGraphemes(title ?? "")).toHaveLength(
      SESSION_TITLE_MAX_GRAPHEMES,
    );
  });

  test("drops the space a cut ends on before the ellipsis", () => {
    const text = `${"c".repeat(SESSION_TITLE_MAX_GRAPHEMES - 2)} tail words`;
    expect(deriveSessionTitle(text)).toBe(
      `${"c".repeat(SESSION_TITLE_MAX_GRAPHEMES - 2)}…`,
    );
  });

  test("counts and cuts CJK by character", () => {
    const text = "세션에 제목을 붙인다".repeat(10);
    const title = deriveSessionTitle(text) ?? "";
    expect(titleGraphemes(title)).toHaveLength(SESSION_TITLE_MAX_GRAPHEMES);
    expect(title.startsWith("세션에 제목을 붙인다세션에")).toBe(true);
  });

  test("never splits an emoji, a flag or a family sequence", () => {
    const family = "👨‍👩‍👧‍👦";
    const flag = "🇰🇷";
    const text = `${family}${flag}`.repeat(SESSION_TITLE_MAX_GRAPHEMES);
    const title = deriveSessionTitle(text) ?? "";
    const parts = titleGraphemes(title);
    expect(parts).toHaveLength(SESSION_TITLE_MAX_GRAPHEMES);
    expect(parts.at(-1)).toBe("…");
    for (const part of parts.slice(0, -1)) {
      expect([family, flag]).toContain(part);
    }
  });

  test("is the same for the same message", () => {
    const text = `Investigate\n\n${"why ".repeat(40)}`;
    expect(deriveSessionTitle(text)).toBe(deriveSessionTitle(text));
  });
});

describe("sessionTitleSchema", () => {
  test("takes a title up to the limit once collapsed", () => {
    const longRaw = ` ${"d".repeat(SESSION_TITLE_MAX_GRAPHEMES)}\n\n`;
    expect(sessionTitleSchema.safeParse(longRaw).success).toBe(true);
    expect(sessionTitleSchema.safeParse("한국어 제목 🚀").success).toBe(true);
  });

  test("refuses one past the limit, an empty one and only whitespace", () => {
    for (const bad of [
      "e".repeat(SESSION_TITLE_MAX_GRAPHEMES + 1),
      "",
      " \n\t ",
    ]) {
      expect(sessionTitleSchema.safeParse(bad).success).toBe(false);
    }
  });
});
