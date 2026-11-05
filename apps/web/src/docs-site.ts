import type { Locale } from "@werft-ai/react";

/**
 * The public documentation site. Every console link to it reads this one
 * constant. The site's bare root only redirects by the browser's language;
 * the console links its own language, which can differ from the browser's.
 */
export const DOCS_SITE_URL = "https://jeongjaesoon.github.io/werft/";

export function docsSiteUrl(locale: Locale): string {
  return `${DOCS_SITE_URL}${locale}/`;
}
