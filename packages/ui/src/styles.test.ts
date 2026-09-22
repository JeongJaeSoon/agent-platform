import { describe, expect, test } from "bun:test";

/*
 * jsdom and happy-dom have no layout engine, so "360px에서 가로 스크롤이 없다"
 * and "prefers-reduced-motion을 존중한다" cannot be observed by rendering. They
 * are enforced here as properties of the stylesheet itself, which is where the
 * regression would actually be introduced.
 */

const TOKENS = await Bun.file(`${import.meta.dir}/tokens.css`).text();
const STYLES = await Bun.file(`${import.meta.dir}/styles.css`).text();

const NARROWEST_VIEWPORT_PX = 360;
const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

interface Declaration {
  readonly selector: string;
  readonly atRules: readonly string[];
  readonly property: string;
  readonly value: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Enough of a CSS parser for flat rules and one level of at-rule nesting. */
function parse(css: string): Declaration[] {
  const declarations: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";

  for (const character of stripComments(css)) {
    if (character === "{") {
      stack.push(buffer.trim());
      buffer = "";
      continue;
    }
    if (character === "}") {
      const selector = stack.pop() ?? "";
      const atRules = stack.filter((entry) => entry.startsWith("@"));
      for (const entry of buffer.split(";")) {
        const [property, ...rest] = entry.split(":");
        if (!property?.trim() || rest.length === 0) continue;
        declarations.push({
          selector,
          atRules,
          property: property.trim(),
          value: rest.join(":").trim(),
        });
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }

  return declarations;
}

const tokenDeclarations = parse(TOKENS);
const styleDeclarations = parse(STYLES);

/** `animation`/`transition` declarations, grouped by property → selectors. */
function motionDeclarations(
  predicate: (d: Declaration) => boolean,
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const declaration of styleDeclarations) {
    const property = /^(animation|transition)(-|$)/.exec(declaration.property);
    if (!property || !predicate(declaration)) continue;
    const selectors = grouped.get(property[1] as string) ?? new Set<string>();
    for (const selector of declaration.selector.split(",")) {
      selectors.add(selector.trim().replace(/\s+/g, " "));
    }
    grouped.set(property[1] as string, selectors);
  }
  return grouped;
}

function customProperties(predicate: (d: Declaration) => boolean): string[] {
  return tokenDeclarations
    .filter((d) => d.property.startsWith("--ap-") && predicate(d))
    .map((d) => d.property);
}

describe("tokens.css", () => {
  test("색 토큰이 라이트·다크 양쪽에 모두 있다", () => {
    const light = new Set(
      customProperties((d) => d.selector === ":root" && d.atRules.length === 0),
    );
    const systemDark = new Set(
      customProperties((d) =>
        d.atRules.includes("@media (prefers-color-scheme: dark)"),
      ),
    );
    const manualDark = new Set(
      customProperties((d) => d.selector === ':root[data-theme="dark"]'),
    );

    const themed = [...light].filter((name) =>
      /^--ap-(color|tone|shadow)-/.test(name),
    );
    expect(themed.length).toBeGreaterThan(0);
    for (const name of themed) {
      expect(systemDark.has(name)).toBe(true);
      expect(manualDark.has(name)).toBe(true);
    }
  });

  test("시스템 설정과 수동 전환을 모두 받는다", () => {
    // `data-theme="light"` must win over the OS preference, or the toggle lies.
    expect(TOKENS).toContain(':root:not([data-theme="light"])');
    expect(TOKENS).toContain(':root[data-theme="dark"]');
  });

  test("모션 토큰이 reduced-motion에서 0이 된다", () => {
    const reduced = tokenDeclarations.filter((d) =>
      d.atRules.includes(REDUCED_MOTION),
    );
    expect(reduced.map((d) => d.property).sort()).toEqual([
      "--ap-motion-fast",
      "--ap-motion-normal",
    ]);
    for (const declaration of reduced) {
      expect(declaration.value).toBe("0ms");
    }
  });
});

describe("styles.css", () => {
  test("색은 tokens.css 한 곳에서만 나온다", () => {
    const literals = styleDeclarations.filter(
      (d) =>
        !d.property.startsWith("--") &&
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(d.value),
    );
    expect(literals.map((d) => `${d.selector} { ${d.property} }`)).toEqual([]);
  });

  test("한글 마이크로라벨을 uppercase로 바꾸지 않는다", () => {
    const uppercased = styleDeclarations.filter(
      (d) => d.property === "text-transform" && d.value !== "none",
    );
    expect(uppercased).toEqual([]);
  });

  test("360px 폭에서 가로로 넘치는 고정 너비가 없다", () => {
    const tooWide = styleDeclarations.filter((d) => {
      if (!["width", "min-width", "max-width"].includes(d.property))
        return false;
      const match = /(\d+(?:\.\d+)?)px/.exec(d.value);
      if (!match) return false;
      return Number(match[1]) > NARROWEST_VIEWPORT_PX;
    });
    expect(
      tooWide.map((d) => `${d.selector} { ${d.property}: ${d.value} }`),
    ).toEqual([]);
  });

  test("모션을 쓰는 선택자마다 reduced-motion 짝이 있다", () => {
    const animated = motionDeclarations(
      (d) => !d.atRules.includes(REDUCED_MOTION),
    );
    const stilled = motionDeclarations((d) =>
      d.atRules.includes(REDUCED_MOTION),
    );

    expect(animated.size).toBeGreaterThan(0);
    for (const [property, selectors] of animated) {
      for (const selector of selectors) {
        // Same selector, same specificity, later in the file — so `none` wins
        // without `!important`. A near-miss selector would silently lose.
        expect(stilled.get(property)?.has(selector)).toBe(true);
      }
    }
  });

  test("reduced-motion 블록이 파일 맨 뒤에 온다", () => {
    const last = styleDeclarations.at(-1);
    expect(last?.atRules).toContain(REDUCED_MOTION);
  });

  test("!important로 캐스케이드를 뒤집지 않는다", () => {
    const shouting = styleDeclarations.filter((d) =>
      d.value.includes("!important"),
    );
    expect(shouting.map((d) => `${d.selector} { ${d.property} }`)).toEqual([]);
  });
});
