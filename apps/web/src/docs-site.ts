import type { Locale } from "@werft-ai/react";

/**
 * The public documentation site. Every console link to it reads this one
 * constant; the site has a page per console language and no unprefixed root
 * page, so a link without a language segment lands on a 404.
 */
export const DOCS_SITE_URL = "https://jeongjaesoon.github.io/werft/";

export function docsSiteUrl(locale: Locale): string {
  return `${DOCS_SITE_URL}${locale}/`;
}
