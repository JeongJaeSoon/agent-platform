/**
 * tailwind-merge drops an earlier `leading-*` when a later class sets the font
 * size, so a caller's `text-*` would take the part's line height with it. The
 * part's line goes on after the merge, unless the caller set a line of its own.
 */
export function withLeading(classes: string, leading: string): string {
  if (leading === "" || /(?:^|\s)(?:[\w-]+:)*leading-/.test(classes))
    return classes;
  return `${classes} ${leading}`;
}
