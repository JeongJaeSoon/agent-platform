import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { remarkHeading } from "fumadocs-core/mdx-plugins";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import pages from "./fixtures/self-hosting-pages.json";
import baseline from "./fixtures/self-hosting-public-urls.json";

const root = join(import.meta.dir, "../apps/docs/content/docs");
const prefix = "run-server/self-hosting";
const held = /operate\/(session-data-flow|monitoring-datadog)$/;

interface Node {
  type: string;
  name?: string;
  url?: string;
  attributes?: { type: string; name: string; value: string }[];
  data?: { hProperties?: { id?: string } };
  children?: Node[];
}

function readPage(path: string, locale: string) {
  const base = join(root, path || "index");
  const localized = `${base}.${locale}.mdx`;
  const source =
    locale !== "ko" && existsSync(localized) ? localized : `${base}.mdx`;
  return readFileSync(source, "utf8");
}

const inspected = new Map<string, { ids: string[]; links: string[] }>();

function inspect(text: string) {
  const cached = inspected.get(text);
  if (cached) return cached;
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMdx)
    .use(remarkHeading);
  const tree = processor.runSync(
    processor.parse(text.replace(/^---\n[\s\S]*?\n---\n/, "")),
  ) as Node;
  const ids: string[] = [];
  const links: string[] = [];
  function walk(node: Node) {
    const id = node.data?.hProperties?.id;
    if (id) ids.push(id);
    if (node.name === "a") {
      const id = node.attributes?.find((a) => a.name === "id")?.value;
      if (id) ids.push(id);
    }
    if (node.type === "link" && node.url) links.push(node.url);
    for (const child of node.children ?? []) walk(child);
  }
  walk(tree);
  const result = { ids, links };
  inspected.set(text, result);
  return result;
}

function targetExists(href: string, current: string, locale: string) {
  if (!href.startsWith("/") && !href.startsWith("#")) return true;
  const url = new URL(href, `https://docs.invalid/${locale}/${current}`);
  const targetLocale = url.pathname.match(/^\/(ko|en|ja)\//)?.[1] ?? locale;
  let path = decodeURIComponent(url.pathname)
    .replace(/^\/(ko|en|ja)\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  if (path.startsWith("reference/http-api/")) return true;
  if (!path) path = "index";
  const source = existsSync(join(root, `${path}.mdx`)) ? path : `${path}/index`;
  try {
    const target = inspect(readPage(source, targetLocale));
    return (
      !url.hash || target.ids.includes(decodeURIComponent(url.hash.slice(1)))
    );
  } catch {
    return false;
  }
}

// This fixture predates the rewrite. It is deliberately not regenerated from
// the new pages: doing so would make deleted public fragments invisible.
describe("self-hosting public URL contract", () => {
  for (const old of baseline.pages) {
    const path = `${prefix}${old.page ? `/${old.page}` : "/index"}`;
    test(`${old.locale}/${old.page}: previous public fragments survive`, () => {
      const { ids } = inspect(readPage(path, old.locale));
      expect(old.fragments.filter((id) => !ids.includes(id))).toEqual([]);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  test("new pages and guide links reach real source pages and fragments", () => {
    const broken: string[] = [];
    for (const file of new Bun.Glob(`${prefix}/**/*.mdx`).scanSync(root)) {
      if (/\.(en|ja)\.mdx$/.test(file) || held.test(file.replace(/\.mdx$/, "")))
        continue;
      const path = file.replace(/\.mdx$/, "");
      for (const locale of ["ko", "en", "ja"]) {
        for (const href of inspect(readPage(path, locale)).links) {
          if (!targetExists(href, path, locale))
            broken.push(`${locale}/${file} -> ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("reader, outcome and page kind match the approved destinations", () => {
    for (const page of pages) {
      const text = readPage(`${prefix}/${page.path}`, "ko");
      expect(text).toContain(`pageId: "${page.id}"`);
      expect(text).toContain(`audience: "${page.audience}"`);
      expect(text).toContain(`outcome: "${page.outcome}"`);
      expect(text).toContain(`docType: "${page.type}"`);
      if (page.type !== "설치" && page.type !== "작업") continue;
      const headings = [
        "무엇을 하게 되나",
        "준비물",
        "단계",
        "확인",
        "자주 막히는 곳",
        "되돌리기",
        "다음에 읽을 곳",
      ];
      const offsets = headings.map((h) => text.indexOf(`\n## ${h}\n`));
      expect(
        offsets.every(
          (offset, i) =>
            offset >= 0 && (i === 0 || offset > (offsets[i - 1] ?? -1)),
        ),
      ).toBe(true);
    }
  });

  test("the contract detects a removed old fragment and a nonexistent target", () => {
    expect(inspect("## 남긴 절\n").ids).not.toContain("삭제한-절");
    expect(
      targetExists("/run-server/self-hosting/missing", `${prefix}/index`, "ko"),
    ).toBe(false);
    expect(targetExists("#missing", `${prefix}/index`, "ko")).toBe(false);
  });
});
