export const appName = "Werft";

// Set by next.config.mjs. Next prefixes it on its own links, but not on plain
// fetches or on hrefs to the sibling sites (/api, /storybook) it does not build.
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const searchIndexRoute = "/search-index.json";
export const markdownRoute = "/llms.mdx";

export function withBasePath(path: string): string {
  return `${basePath}${path}`;
}

/** `/llms.mdx/<slugs>/content.md`: the Markdown copy of one page. */
export function getPageMarkdownUrl(page: { slugs: string[] }) {
  const segments = [...page.slugs, "content.md"];
  return {
    segments,
    url: withBasePath(`${markdownRoute}/${segments.join("/")}`),
  };
}
