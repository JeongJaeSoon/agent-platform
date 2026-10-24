import { cn } from "../foundations/cn.ts";

// A caller's own base line: `leading-*` with no variant, or a size with its
// line (`text-lg/8`, `text-[calc(1rem+2px)]/6`). tailwind-merge itself tells a
// size from a colour with opacity (`text-[#123456]/80`): only a size drops a
// leading class merged before it.
function setsBaseLine(token: string): boolean {
  if (/^[^[(]*:/.test(token)) return false;
  if (token.startsWith("leading-")) return true;
  return (
    token.startsWith("text-") &&
    token.includes("/") &&
    !cn("leading-px", token).split(" ").includes("leading-px")
  );
}

/**
 * tailwind-merge drops an earlier `leading-*` when a later class sets the font
 * size, so a caller's `text-*` would take the part's line height with it. The
 * part's line goes on after the merge, unless the caller set a base line of
 * its own; a variant line (`md:leading-5`) applies on top of it.
 */
export function withLeading(classes: string, leading: string): string {
  if (leading === "" || classes.split(/\s+/).some(setsBaseLine)) return classes;
  return `${classes} ${leading}`;
}
