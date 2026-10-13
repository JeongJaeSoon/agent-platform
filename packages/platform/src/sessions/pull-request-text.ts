// Text that reaches a pull request is partly the agent's, and GitHub acts on
// it: a mention notifies, a cross-reference links another repository, a
// closing keyword closes an issue on merge, and an HTML comment hides text
// from the reader. A zero-width space keeps each visible but inert.

const ZWSP = "​";
export const PULL_REQUEST_TITLE_MAX = 256;
const TRUNCATED = "\n\n…(truncated)";

const closingKeyword =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)(?=#\d|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d|https?:\/\/)/gi;
const crossReference = /\b([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d)/g;
const mention = /(^|[^\w`])@([A-Za-z0-9])/g;

/** Breaks mentions, cross-repository references, closing keywords and HTML comments. */
export function neutralizeReferences(text: string): string {
  return text
    .replace(
      closingKeyword,
      (_, word: string, gap: string) =>
        `${word[0]}${ZWSP}${word.slice(1)}${gap}`,
    )
    .replace(crossReference, `$1#${ZWSP}$2`)
    .replace(mention, `$1@${ZWSP}$2`)
    .replaceAll("<!--", `<!${ZWSP}--`);
}

function cut(text: string, max: number, suffix: string): string {
  if (text.length <= max) return text;
  let kept = text.slice(0, Math.max(0, max - suffix.length));
  // Never leave half of a surrogate pair at the cut.
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${suffix}`;
}

/**
 * A body or comment as the forge may take it: each line through `redact`
 * (a secret-shaped line becomes a placeholder), references neutralized,
 * cut to `max` characters.
 */
export function cleanBody(
  text: string,
  max: number,
  redact: (line: string) => string,
): string {
  const redacted = text.split("\n").map(redact).join("\n");
  return cut(neutralizeReferences(redacted), max, TRUNCATED);
}

/** One line, redacted and neutralized, at most `PULL_REQUEST_TITLE_MAX`. */
export function cleanTitle(
  text: string,
  redact: (line: string) => string,
): string {
  const line = redact(text.replace(/\s+/g, " ").trim());
  return cut(neutralizeReferences(line), PULL_REQUEST_TITLE_MAX, "…");
}
