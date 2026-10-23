import { describe, expect, test } from "bun:test";

/*
 * happy-dom has no layout engine, so widths and motion cannot be observed by
 * rendering. These are properties of the stylesheet instead, as in
 * packages/ui/src/foundations/styles.test.ts.
 */
const css = await Bun.file(`${import.meta.dir}/styles.css`).text();

describe("styles.css", () => {
  test("takes the Tailwind theme from packages/ui instead of its own", () => {
    const imports = [...css.matchAll(/@import "([^"]+)";/g)].map(([, p]) => p);
    expect(imports).toEqual([
      "tailwindcss",
      "@werft-ai/ui/styles.css",
      "@werft-ai/ui/theme.css",
    ]);
    expect(css).not.toContain("@theme");
  });

  test("Japanese wraps between characters, not only at spaces", () => {
    expect(css).toMatch(/:lang\(ja\) body \{\s*word-break: normal;/);
  });

  test("Japanese takes a Japanese face before Pretendard, so no word mixes faces", () => {
    const stack =
      css.match(/:lang\(ja\) \{\s*--ap-font-sans:([^;]+);/)?.[1] ?? "";
    expect(stack.indexOf("Hiragino Sans")).toBeGreaterThan(-1);
    expect(stack.indexOf("Hiragino Sans")).toBeLessThan(
      stack.indexOf("Pretendard"),
    );
    expect(css).toMatch(
      /\[lang="ja"\] \{\s*font-family: var\(--ap-font-sans\);/,
    );
  });

  test("steps at 768 and fixes nothing wider than 360px", () => {
    expect(css).toContain("@media (min-width: 48rem)");
    for (const [, value] of css.matchAll(
      /(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g,
    )) {
      expect(Number(value)).toBeLessThanOrEqual(360);
    }
  });

  test("shows keyboard focus on every interactive element", () => {
    const rule =
      css.match(/([^}]*):focus-visible\s*\{[^}]*outline:[^}]*\}/)?.[0] ?? "";
    for (const selector of ["a", "button", "input", "select"]) {
      expect(rule).toContain(`${selector}:focus-visible`);
    }
  });

  test("link colors leave links drawn as buttons alone", () => {
    const prelude =
      css.match(/([^{}]*)\{\s*color: var\(--ap-color-accent\);/)?.[1] ?? "";
    const selectors = (prelude.split("*/").pop() ?? "")
      .split(",")
      .map((s) => s.trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors)
      expect(selector).toEndWith('a:not([data-slot="button"]):not(.ap-button)');
  });

  test("breaks Korean between words", () => {
    const body = css.match(/\nbody \{([^}]*)\}/)?.[1] ?? "";
    expect(body).toContain("word-break: keep-all");
  });

  test("keeps nowrap table cells on one line", () => {
    const rule = css.match(
      /\.web-table--nowrap th,\s*\.web-table--nowrap td \{([^}]*)\}/,
    )?.[1];
    expect(rule).toContain("white-space: nowrap");
  });

  test("declares no animation of its own; motion comes from utilities", () => {
    expect(css).not.toContain("@keyframes");
  });
});
