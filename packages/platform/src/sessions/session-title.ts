import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX_GRAPHEMES,
  titleGraphemes,
} from "@werft-ai/contracts";

/**
 * The title a session gets from its first message when none was given.
 * Deterministic and model-free: whitespace collapsed, then cut on a grapheme
 * boundary so an emoji or a combined character is never split. Null when
 * nothing is left.
 */
export function deriveSessionTitle(text: string): string | null {
  const normalized = normalizeSessionTitle(text);
  if (normalized === "") return null;
  const parts = titleGraphemes(normalized);
  if (parts.length <= SESSION_TITLE_MAX_GRAPHEMES) return normalized;
  const kept = parts
    .slice(0, SESSION_TITLE_MAX_GRAPHEMES - 1)
    .join("")
    .trimEnd();
  return `${kept}…`;
}
