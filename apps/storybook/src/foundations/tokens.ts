/*
 * Reads tokens.css itself, so the Foundations stories list what the file
 * declares and never a copy of it. `light` is the first `:root` block;
 * `dark` is the manual `:root[data-theme="dark"]` block laid over it.
 */

export type Tokens = ReadonlyMap<string, string>;

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`tokens.css has no ${selector} block`);
  let depth = 0;
  for (let at = css.indexOf("{", start); at < css.length; at += 1) {
    if (css[at] === "{") depth += 1;
    if (css[at] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, at);
  }
  throw new Error(`tokens.css: ${selector} is not closed`);
}

function declarations(text: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of text.matchAll(
    /(--ap-[\w-]+)\s*:\s*([^;]+);/g,
  )) {
    tokens.set(name as string, (value as string).replace(/\s+/g, " ").trim());
  }
  return tokens;
}

export function parseTokens(css: string): { light: Tokens; dark: Tokens } {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = declarations(block(source, ":root"));
  const dark = new Map([
    ...light,
    ...declarations(block(source, ':root[data-theme="dark"]')),
  ]);
  return { light, dark };
}

/** Inline custom properties that put a subtree in one theme. */
export function themeStyle(tokens: Tokens): Record<string, string> {
  return Object.fromEntries(tokens);
}

export function withPrefix(tokens: Tokens, ...prefixes: string[]): string[] {
  return [...tokens.keys()].filter((name) =>
    prefixes.some((prefix) => name.startsWith(prefix)),
  );
}
