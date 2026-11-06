import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const docsRoot = join(import.meta.dir, "..", "apps/docs/content/docs");

const OPERATE = [
  "capacity",
  "configuration",
  "database",
  "execution",
  "images-and-supply-chain",
  "kubernetes-deployment",
  "kubernetes-backend",
  "metrics",
  "monitoring-datadog",
  "sdk-sample",
  "session-data-flow",
].map((name) => `run-server/self-hosting/operate/${name}`);

// CI runs only the Korean api-guide, so a translation whose commands drift
// from it would document a flow nobody runs. Translating prose is free; the
// fenced code must stay byte-identical across ko, en and ja.
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let open: string[] | undefined;
  for (const line of text.split("\n")) {
    if (open === undefined) {
      if (/^```\S*$/.test(line)) open = [line];
      // Indented or ~~~ fences are real code blocks to a Markdown parser but
      // invisible to this extractor, so refuse them instead of skipping them.
      else expect(line).not.toMatch(/^\s*(```|~~~)/);
    } else if (line === "```") {
      blocks.push([...open, line].join("\n"));
      open = undefined;
    } else {
      open.push(line);
    }
  }
  expect(open).toBeUndefined();
  return blocks;
}

function pageBlocks(name: string, locale?: string): string[] {
  const file = locale ? `${name}.${locale}.mdx` : `${name}.mdx`;
  return fencedBlocks(readFileSync(join(docsRoot, file), "utf8"));
}

describe("translated pages keep the Korean code blocks", () => {
  for (const page of [
    "reference/api-guide",
    "reference/examples",
    ...OPERATE,
  ]) {
    const source = pageBlocks(page);

    // These pages have no code; the per-language comparison still catches a
    // block added to only one of them.
    const noCode = /\/(kubernetes-backend|sdk-sample)$/.test(page);
    test(`${page}: the Korean page has ${noCode ? "no" : "some"} code blocks`, () => {
      if (noCode) expect(source).toEqual([]);
      else expect(source.length).toBeGreaterThan(0);
    });

    for (const locale of ["en", "ja"]) {
      test(`${page}.${locale} matches ${page}`, () => {
        expect(pageBlocks(page, locale)).toEqual(source);
      });
    }
  }

  test("the extractor rejects fences it cannot compare", () => {
    expect(() => fencedBlocks("~~~sh\necho a\n~~~\n")).toThrow();
    expect(() => fencedBlocks("   ```sh\necho a\n   ```\n")).toThrow();
    expect(() => fencedBlocks("```sh\necho a\n")).toThrow();
  });

  test("the extractor sees an edited block as a difference", () => {
    const original = "text\n```bash\necho a\n```\n";
    expect(fencedBlocks(original.replace("echo a", "echo b"))).not.toEqual(
      fencedBlocks(original),
    );
  });
});
