// A caller's own base line: `leading-*` with no variant, or a size with its
// line (`text-lg/8`, `text-[15px]/6`). A colour with opacity
// (`text-foreground/80`, `text-[#123456]/80`) is not one.
const OWN_LEADING =
  /(?:^|\s)(?:leading-\S|text-(?:caption|control|body|description|title|number|2xs|xs|sm|base|lg|\d?xl|\[(?:length:[^\]\s]+|[\d.]+[a-z%]+)\])\/)/;

/**
 * tailwind-merge drops an earlier `leading-*` when a later class sets the font
 * size, so a caller's `text-*` would take the part's line height with it. The
 * part's line goes on after the merge, unless the caller set a base line of
 * its own; a variant line (`md:leading-5`) applies on top of it.
 */
export function withLeading(classes: string, leading: string): string {
  if (leading === "" || OWN_LEADING.test(classes)) return classes;
  return `${classes} ${leading}`;
}
