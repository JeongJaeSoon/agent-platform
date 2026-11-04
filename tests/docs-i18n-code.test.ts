import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reference = join(
  import.meta.dir,
  "..",
  "apps/docs/content/docs/reference",
);

// CI runs only the Korean api-guide, so a translation whose commands drift
// from it would document a flow nobody runs. Translating prose is free; the
// fenced code must stay byte-identical across ko, en and ja.
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let open: string[] | undefined;
  for (const line of text.split("\n")) {
    if (open === undefined) {
      if (/^```\S*$/.test(line)) open = [line];
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
  return fencedBlocks(readFileSync(join(reference, file), "utf8"));
}

describe("translated pages keep the Korean code blocks", () => {
  for (const page of ["api-guide", "examples"]) {
    const source = pageBlocks(page);

    test(`${page}: the Korean page has code blocks`, () => {
      expect(source.length).toBeGreaterThan(0);
    });

    for (const locale of ["en", "ja"]) {
      test(`${page}.${locale} matches ${page}`, () => {
        expect(pageBlocks(page, locale)).toEqual(source);
      });
    }
  }

  test("the extractor sees an edited block as a difference", () => {
    const original = "text\n```bash\necho a\n```\n";
    expect(fencedBlocks(original.replace("echo a", "echo b"))).not.toEqual(
      fencedBlocks(original),
    );
  });
});
