import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Documentation lives on the docs site. A link from the product, the site, the
// Storybook or a published package README to a Markdown file or a docs
// directory on github.com opens a raw README instead of a site page.
const SITE = "https://jeongjaesoon.github.io/werft";
const REPO_DOC =
  /https:\/\/(?:github\.com\/jeongjaesoon\/werft\/(?:blob|tree|raw)|raw\.githubusercontent\.com\/jeongjaesoon\/werft)\/[^/\s)"'>]+\/([^\s)"'>#?]+)/gi;

// Repository paths that may still be linked, each with the reason there is no
// site page for it. Drop an entry when its page exists: the stale-entry test
// below fails on one nothing links to any more.
const ALLOWED: Record<string, string> = {
  "packages/ui/README.md":
    "contributor rules for building screens; the Storybook introduction links its source of truth",
  "docs/api-guide.md": "no site page yet",
  examples: "no site page yet",
  "examples/README.md": "no site page yet",
  "examples/sdk-approver/README.md": "no site page yet",
  "docs/quickstart.md":
    "the restart section has no site page; CI runs this file as written",
  "docs/contributing": "contributor documents stay in the repository",
  "docs/contributing/architecture.md": "contributor document",
  "docs/contributing/ci.md": "contributor document",
  "docs/contributing/development.md": "contributor document",
  "docs/contributing/i18n-glossary.md": "contributor document",
  "docs/contributing/local-model.md": "contributor document",
  "docs/contributing/decisions": "contributor document",
  "docs/operator": "self-hosting pages are split separately",
};
const ALLOWED_PREFIXES: Record<string, string> = {
  "docs/operator/": "self-hosting pages are split separately",
};

const SCANNED = [
  "README.md",
  "apps/**/*.{md,mdx,ts,tsx,js,jsx,mjs,json,html}",
  "packages/**/*.{md,mdx,ts,tsx,js,jsx,mjs,json,html}",
];
const SKIPPED = /(^|\/)(node_modules|dist|\.next|out)\/|\.test\.tsx?$/;

// Source code, configuration and workflows are not documentation.
function isDocTarget(path: string): boolean {
  return (
    !/\.(ts|tsx|js|jsx|mjs|json|ya?ml|sh)$/.test(path) &&
    (/\.mdx?$/.test(path) || /^(docs|examples)(\/|$)/.test(path))
  );
}

function allowed(path: string): boolean {
  return (
    path in ALLOWED ||
    Object.keys(ALLOWED_PREFIXES).some((prefix) => path.startsWith(prefix))
  );
}

function repoDocLinks(): { file: string; path: string }[] {
  const links: { file: string; path: string }[] = [];
  for (const pattern of SCANNED) {
    for (const file of new Bun.Glob(pattern).scanSync(root)) {
      if (SKIPPED.test(file)) continue;
      // A commented-out link is not a link, for the stale-entry test too.
      const text = readFileSync(join(root, file), "utf8").replace(
        /<!--[\s\S]*?-->/g,
        "",
      );
      for (const match of text.matchAll(REPO_DOC)) {
        const path = decodeURIComponent(match[1] ?? "").replace(/\/$/, "");
        if (isDocTarget(path)) links.push({ file, path });
      }
    }
  }
  return links;
}

describe("Documentation links", () => {
  test("none opens a repository Markdown file the docs site has a page for", () => {
    const stray = repoDocLinks()
      .filter((link) => !allowed(link.path))
      .map((link) => `${link.file} -> ${link.path}`);
    expect(stray).toEqual([]);
  });

  test("every allowed repository path is still linked", () => {
    const linked = repoDocLinks().map((link) => link.path);
    const stale = [
      ...Object.keys(ALLOWED).filter((path) => !linked.includes(path)),
      ...Object.keys(ALLOWED_PREFIXES).filter(
        (prefix) => !linked.some((path) => path.startsWith(prefix)),
      ),
    ];
    expect(stale).toEqual([]);
  });

  test("the SDK README sends readers to the site", () => {
    const readme = readFileSync(join(root, "packages/sdk/README.md"), "utf8");
    expect(readme).toContain(`${SITE}/ko/sdk/`);
  });

  test("the scanner flags a README link and passes a site link", () => {
    const sample = (path: string) =>
      `https://github.com/JeongJaeSoon/werft/blob/main/${path}`;
    expect(allowed("docs/sdk.md")).toBe(false);
    expect(isDocTarget("docs/sdk.md")).toBe(true);
    expect(isDocTarget("scripts/probe.ts")).toBe(false);
    expect([...sample("docs/sdk.md").matchAll(REPO_DOC)]).toHaveLength(1);
    expect([...`${SITE}/ko/sdk/`.matchAll(REPO_DOC)]).toHaveLength(0);
    for (const url of [
      "https://raw.githubusercontent.com/JeongJaeSoon/werft/main/docs/sdk.md",
      "https://github.com/jeongjaesoon/werft/blob/main/docs/sdk.md",
      "https://github.com/JeongJaeSoon/werft/blob/main/README.md?plain=1",
      "https://github.com/JeongJaeSoon/werft/blob/4b014d7/docs/sdk.md",
    ]) {
      expect([...url.matchAll(REPO_DOC)]).toHaveLength(1);
    }
    expect(isDocTarget("apps/docs/content/docs/sdk.mdx")).toBe(true);
  });
});
