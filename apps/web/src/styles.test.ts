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
    // `.web-auth a` outranks `.ap-button--primary` and painted its label in
    // the button's own background color; a packages/ui Button drawn as a
    // link is the same case under its own marker.
    const rule = css.match(
      /\*\/\s*([^{}/]*)\{\s*color: var\(--ap-color-accent\);/,
    );
    const selectors = (rule?.[1] ?? "").split(",").map((s) => s.trim());
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

  test("draws focus on the dark rail in the rail's light foreground", () => {
    const rule = css.match(
      /\[data-slot="app-sidebar"\] :focus-visible \{([^}]*)\}/,
    )?.[1];
    expect(rule).toContain("var(--ap-color-rail-foreground)");
  });

  test("stops animation under prefers-reduced-motion", () => {
    const block = css.split("@media (prefers-reduced-motion: reduce)")[1] ?? "";
    expect(block).toContain("animation: none");
  });
});
