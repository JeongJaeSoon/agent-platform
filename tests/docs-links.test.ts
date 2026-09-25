import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

// Inline links and images `[text](target)` and reference definitions
// `[label]: target`. Fenced blocks and code spans are dropped first: a
// snippet showing Markdown is not a link.
const INLINE = /!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)/g;
const REFERENCE = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm;

function relativeTargets(markdown: string): string[] {
  const prose = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "")
    .replace(/(`+)[\s\S]*?\1/g, "");
  const targets = [...prose.matchAll(INLINE), ...prose.matchAll(REFERENCE)].map(
    (match) => (match[1] ?? "").replace(/^<|>$/g, ""),
  );
  return targets
    .filter((target) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target))
    .map((target) => decodeURIComponent(target.replace(/[#?].*$/, "")))
    .filter((path) => path !== "");
}

function trackedMarkdown(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "*.md"], {
    cwd: root,
  });
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout.toString().split("\0").filter(Boolean);
}

describe("Markdown relative links", () => {
  test("every one names a file or directory that exists", () => {
    const files = trackedMarkdown();
    expect(files).toContain("README.md");
    const broken = files.flatMap((file) =>
      relativeTargets(readFileSync(join(root, file), "utf8"))
        .filter((path) => !existsSync(join(root, dirname(file), path)))
        .map((path) => `${file} -> ${path}`),
    );
    expect(broken).toEqual([]);
  });

  test("the parser keeps relative paths and drops the rest", () => {
    const page = [
      "[a](docs/a.md) [b](../b.md#part) ![c](img/c%20d.png)",
      "[web](https://x.test/y) [anchor](#here) [mail](mailto:a@x.test)",
      "[root](/abs/path.md) [angle](<e f.md>) [a [nested] label](n.md)",
      "[escaped](x%23y.md#frag)",
      "`[code](not-a-link.md)`",
      "```",
      "[fenced](not-a-link-either.md)",
      "```",
      "[ref]: ./ref.md",
    ].join("\n");
    expect(relativeTargets(page).sort()).toEqual(
      [
        "../b.md",
        "./ref.md",
        "docs/a.md",
        "e f.md",
        "img/c d.png",
        "n.md",
        "x#y.md",
      ].sort(),
    );
  });
});
