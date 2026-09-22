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
const ROOT_FONT_SIZE_PX = 16;
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

/** WCAG relative luminance, then the 2.1 contrast ratio. */
function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5]
      .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return (
      0.2126 * (channels[0] as number) +
      0.7152 * (channels[1] as number) +
      0.0722 * (channels[2] as number)
    );
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Token name → value, for one theme's block. */
function paletteOf(
  predicate: (d: Declaration) => boolean,
): Map<string, string> {
  const palette = new Map<string, string>();
  for (const declaration of tokenDeclarations) {
    if (
      !declaration.property.startsWith("--ap-color") &&
      !declaration.property.startsWith("--ap-tone")
    ) {
      continue;
    }
    if (!predicate(declaration)) continue;
    palette.set(declaration.property, declaration.value);
  }
  return palette;
}

describe("tokens.css", () => {
  test("본문 색이 앉을 수 있는 모든 바탕에서 AA를 넘는다", () => {
    // 12px 상태 문구까지 포함하므로 large-text 예외(3:1)는 쓰지 않는다.
    const AA = 4.5;
    const SURFACES = [
      "--ap-color-canvas",
      "--ap-color-surface",
      "--ap-color-surface-sunken",
      ...[
        "neutral",
        "progress",
        "attention",
        "caution",
        "danger",
        "unknown",
        "positive",
      ].map((tone) => `--ap-tone-${tone}-bg`),
    ];
    const light = paletteOf(
      (d) => d.selector === ":root" && d.atRules.length === 0,
    );
    const themes: [string, Map<string, string>][] = [
      ["light", light],
      [
        "dark(수동)",
        paletteOf((d) => d.selector === ':root[data-theme="dark"]'),
      ],
      [
        // The OS-preference block is a third theme, not a copy: a regression
        // that only lands there would otherwise go unmeasured.
        "dark(시스템)",
        paletteOf((d) =>
          d.atRules.includes("@media (prefers-color-scheme: dark)"),
        ),
      ],
    ];
    const TEXT = ["--ap-color-foreground", "--ap-color-muted-foreground"];
    const RAIL_TEXT = [
      "--ap-color-rail-foreground",
      "--ap-color-rail-muted-foreground",
    ];

    const failures: string[] = [];
    // A token this test cannot read is a hole in it, not a pass. Every pair
    // below must resolve to a hex value in every theme.
    const colourOf = (
      theme: string,
      palette: Map<string, string>,
      name: string,
    ): string | null => {
      const value = palette.get(name);
      if (value && /^#[0-9a-f]{6}$/i.test(value)) return value;
      failures.push(`${theme}: ${name} = ${value ?? "없음"} (읽을 수 없다)`);
      return null;
    };

    for (const [theme, palette] of themes) {
      expect(palette.size).toBeGreaterThan(0);
      for (const [texts, surfaces] of [
        [TEXT, SURFACES],
        [RAIL_TEXT, ["--ap-color-rail"]],
      ] as [string[], string[]][]) {
        for (const text of texts) {
          const fg = colourOf(theme, palette, text);
          for (const surface of surfaces) {
            const bg = colourOf(theme, palette, surface);
            if (!fg || !bg) continue;
            const ratio = contrast(fg, bg);
            if (ratio < AA) {
              failures.push(
                `${theme}: ${text} on ${surface} = ${ratio.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

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
      // A big intrinsic width is fine when `min()` caps it against the
      // container. `clamp(a, b, c)` does not: its floor is `a`, so only the
      // first argument is read below.
      // `100%` is the container; `vw` includes the scrollbar and is what
      // pushed the dialog sideways once already. A `+` inside the cap means
      // it grows past the container, so it is not a cap.
      const cappedToContainer =
        /^\s*min\(/.test(d.value) &&
        d.value.includes("100%") &&
        !/\bvw\b/.test(d.value) &&
        !/100%\s*\+/.test(d.value);
      const value = cappedToContainer
        ? ""
        : (/^\s*clamp\((.*)$/.exec(d.value)?.[1]?.split(",")[0] ?? d.value);
      // rem as well as px: `width: 40rem` is 640px at the default root size,
      // and this package states its widths in rem.
      const match = /(\d+(?:\.\d+)?)(px|rem)\b/.exec(value);
      if (!match) return false;
      const px =
        Number(match[1]) * (match[2] === "rem" ? ROOT_FONT_SIZE_PX : 1);
      return px > NARROWEST_VIEWPORT_PX;
    });
    expect(
      tooWide.map((d) => `${d.selector} { ${d.property}: ${d.value} }`),
    ).toEqual([]);
  });

  test("서버가 준 글자를 그리는 자리는 모두 끊어서 감싼다", () => {
    /*
     * 360px에서 넘치는지는 레이아웃 엔진 없이는 볼 수 없지만, 원인은 볼 수
     * 있다 — 서버 문자열(식별자·URL·트레이스 토큰)에는 공백이 없을 수 있고,
     * flex 항목의 최소 폭은 가장 긴 단어다.
     */
    const SERVER_TEXT = [
      ".ap-status__text",
      ".ap-status__detail",
      ".ap-receipt__operation",
      ".ap-receipt__id",
      ".ap-receipt__detail",
      ".ap-receipt-link__text",
      ".ap-receipt-link__id",
      ".ap-state__description",
      ".ap-state__code",
    ];
    const declared = new Map<string, Set<string>>();
    for (const declaration of styleDeclarations) {
      if (declaration.atRules.length > 0) continue;
      for (const selector of declaration.selector.split(",")) {
        const key = selector.trim();
        const properties = declared.get(key) ?? new Set<string>();
        properties.add(declaration.property);
        declared.set(key, properties);
      }
    }
    const missing = SERVER_TEXT.filter(
      (selector) => !declared.get(selector)?.has("overflow-wrap"),
    );
    expect(missing).toEqual([]);
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

  test("reduced-motion 짝이 모션을 실제로 끈다", () => {
    // The pairing test above only proves the selector is repeated. Without
    // this one, `animation: ap-spin 900ms linear infinite` in the reduced
    // block would still pass while nothing at all was stilled.
    const stilled = styleDeclarations.filter(
      (d) =>
        d.atRules.includes(REDUCED_MOTION) &&
        /^(animation|transition)(-|$)/.test(d.property),
    );
    expect(stilled.length).toBeGreaterThan(0);
    for (const declaration of stilled) {
      expect(declaration.value).toBe("none");
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
