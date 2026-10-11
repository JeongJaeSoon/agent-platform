import { describe, expect, test } from "bun:test";

/*
 * happy-dom has no layout engine, so widths and motion cannot be observed by
 * rendering. These are properties of the stylesheet instead, as in
 * packages/ui/src/styles.test.ts.
 */
const css = await Bun.file(`${import.meta.dir}/styles.css`).text();

describe("styles.css", () => {
  test("connects the packages/ui tokens to Tailwind through @theme inline", () => {
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain('@import "@agent-platform/ui/styles.css";');
    const theme = css.match(/@theme inline \{([^}]*)\}/)?.[1] ?? "";
    const mappings = [...theme.matchAll(/--([\w-]+):\s*var\(--ap-([\w-]+)\)/g)];
    expect(mappings.length).toBeGreaterThan(10);
    for (const [, name] of mappings)
      expect(name?.startsWith("ap-")).toBe(false);
  });

  test("steps at 768 and 1440 and fixes nothing wider than 360px", () => {
    expect(css).toContain("@media (min-width: 48rem)");
    expect(css).toContain("@media (min-width: 90rem)");
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

  test("stops animation under prefers-reduced-motion", () => {
    const block = css.split("@media (prefers-reduced-motion: reduce)")[1] ?? "";
    expect(block).toContain("animation: none");
  });
});
