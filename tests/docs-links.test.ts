import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

// Inline links and images `[text](target)` and reference definitions
// `[label]: target`. Fenced blocks, HTML comments and code spans are dropped
// first: a snippet showing Markdown is not a link.
const INLINE = /!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)/g;
const REFERENCE = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;
const COMMENT = /<!--[\s\S]*?-->/g;
// One left-to-right pass, so a backtick inside a comment cannot pair with
// one after it and hide the links in between.
const COMMENT_OR_CODE = /<!--[\s\S]*?-->|(`+)[\s\S]*?\1/g;

interface Link {
  path: string;
  anchor: string;
}

function relativeLinks(markdown: string): Link[] {
  const prose = markdown.replace(FENCE, "").replace(COMMENT_OR_CODE, "");
  const targets = [...prose.matchAll(INLINE), ...prose.matchAll(REFERENCE)].map(
    (match) => (match[1] ?? "").replace(/^<|>$/g, ""),
  );
  return targets
    .filter((target) => !/^([a-z][a-z0-9+.-]*:|\/)/i.test(target))
    .map((target) => {
      const [, path = "", anchor = ""] =
        /^([^#?]*)(?:\?[^#]*)?(?:#(.*))?$/.exec(target) ?? [];
      return {
        path: decodeURIComponent(path),
        anchor: decodeURIComponent(anchor),
      };
    });
}

function relativeTargets(markdown: string): string[] {
  return relativeLinks(markdown)
    .map((link) => link.path)
    .filter((path) => path !== "");
}

// GitHub's heading id: markup and punctuation dropped, spaces to hyphens.
// Symbols such as the circled digit in "② 이벤트 관찰" go too.
function slug(heading: string): string {
  return heading
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd}\p{Nl}\p{Mn}_ -]/gu, "")
    .replace(/ /g, "-");
}

function headingAnchors(markdown: string): Set<string> {
  const prose = markdown.replace(FENCE, "").replace(COMMENT, "");
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const match of prose.matchAll(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm)) {
    const base = slug(match[1] ?? "");
    const count = seen.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    seen.set(base, count + 1);
  }
  return anchors;
}

function trackedMarkdown(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "*.md"], {
    cwd: root,
  });
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout.toString().split("\0").filter(Boolean);
}

function relativeHtmlTargets(html: string): string[] {
  return [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? "")
    .filter((target) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target))
    .map((target) => decodeURIComponent(target.replace(/[#?].*$/, "")))
    .filter((path) => path !== "");
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

  test("every anchor names a heading in the file it points to", () => {
    const anchorsOf = new Map<string, Set<string>>();
    const broken = trackedMarkdown().flatMap((file) =>
      relativeLinks(readFileSync(join(root, file), "utf8"))
        .filter((link) => link.anchor !== "")
        .map((link) => ({
          ...link,
          target: link.path === "" ? file : join(dirname(file), link.path),
        }))
        .filter(
          ({ target }) =>
            target.endsWith(".md") && existsSync(join(root, target)),
        )
        .filter(({ target, anchor }) => {
          let anchors = anchorsOf.get(target);
          if (!anchors) {
            anchors = headingAnchors(readFileSync(join(root, target), "utf8"));
            anchorsOf.set(target, anchors);
          }
          return !anchors.has(anchor.toLowerCase());
        })
        .map(({ path, anchor }) => `${file} -> ${path}#${anchor}`),
    );
    expect(anchorsOf.size).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });

  test("headings get GitHub's anchors", () => {
    const page = [
      "# Quickstart — 로컬 스택과 curl로 세션 한 바퀴",
      "## ② 이벤트 관찰",
      "## `events` 표",
      "### workers·control-host 롤백 (v2.1)",
      "## [링크](x.md) 제목 ##",
      "## 반복",
      "## 반복",
      "```",
      "## fenced",
      "```",
      "<!--",
      "## commented",
      "-->",
    ].join("\n");
    expect([...headingAnchors(page)].sort()).toEqual(
      [
        "quickstart--로컬-스택과-curl로-세션-한-바퀴",
        "-이벤트-관찰",
        "events-표",
        "workerscontrol-host-롤백-v21",
        "링크-제목",
        "반복",
        "반복-1",
      ].sort(),
    );
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
      "<!-- a ```bash block and one `tick -->",
      "[after comment](c.md) `[code](still-not.md)`",
      "<!-- [commented](not-a-link-at-all.md) -->",
    ].join("\n");
    expect(relativeTargets(page).sort()).toEqual(
      [
        "../b.md",
        "./ref.md",
        "c.md",
        "docs/a.md",
        "e f.md",
        "img/c d.png",
        "n.md",
        "x#y.md",
      ].sort(),
    );
    expect(relativeLinks(page).filter((link) => link.anchor !== "")).toEqual([
      { path: "../b.md", anchor: "part" },
      { path: "", anchor: "here" },
      { path: "x#y.md", anchor: "frag" },
    ]);
  });

  // Not yet rewritten to describe only current behavior.
  const TICKET_EXEMPT = ["docs/operations.md"];

  test("none names a ticket", () => {
    const files = trackedMarkdown().filter(
      (file) => !TICKET_EXEMPT.includes(file),
    );
    const found = files.flatMap((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /\b94S-\d+/.test(line) ? [`${file}:${index + 1}`] : [],
        ),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });

  test("every generated API HTML asset exists", () => {
    const file = "docs/api/index.html";
    const broken = relativeHtmlTargets(readFileSync(join(root, file), "utf8"))
      .filter((path) => !existsSync(join(root, dirname(file), path)))
      .map((path) => `${file} -> ${path}`);
    expect(broken).toEqual([]);
  });
});

// Setting names, found the way check.py found them for the feature map
// read off an environment object, or handed by name to a parser.
const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";
const CODE_READS = [
  new RegExp(
    String.raw`(?:process\.env|Bun\.env|\benv|\benvironment|\bsource)\s*(?:\?\.|\.|\[\s*["'])(${NAME})`,
    "g",
  ),
  new RegExp(
    String.raw`\b\w*(?:[Ee]nv|integer|setting|required|optional)\w*\(\s*(?:[a-z]\w*\s*,\s*)*["'](${NAME})["']`,
    "g",
  ),
];
// `${NAME:-default}` or `${NAME:?message}`: compose or a script takes it
// from the operator's shell.
const SHELL_DEFAULTS = new RegExp(String.raw`\$\{(${NAME}):[-?]`, "g");

/** Names the scan finds that no operator sets, each with why. */
const NOT_SETTINGS: Record<string, string> = {
  // Read beside HTTP_PROXY, which is documented, only to leave DNS to Bun
  // whenever any proxy is set (s3.ts).
  ALL_PROXY: "a standard proxy variable, not one of ours",
  DOCKER_BACKEND_TEST_HELPER_IMAGE: "tests only",
  GIT_ALLOW_PROTOCOL: "written into git's environment, not read",
  GIT_CONFIG_COUNT: "written into git's environment, not read",
  NODE_EXTRA_CA_CERTS: "written into the engine's environment, not read",
};

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function scan(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync(root)];
}

/** What apps/ and packages/ read at runtime; test helpers are not settings. */
function codeSettings(): Set<string> {
  const names = new Set<string>();
  for (const file of scan("{apps,packages}/**/*.ts")) {
    if (
      /(^|\/)(node_modules|dist|bench)\//.test(file) ||
      file.startsWith("packages/testkit/") ||
      /\.(test|integration)\.ts$/.test(file)
    ) {
      continue;
    }
    const source = withoutComments(readFileSync(join(root, file), "utf8"));
    for (const pattern of CODE_READS) {
      for (const match of source.matchAll(pattern)) names.add(match[1] ?? "");
    }
  }
  // The pass loop builds each role's names from a prefix and a suffix.
  const loop = readFileSync(
    join(root, "apps/control-host/src/pass-loop/loop.ts"),
    "utf8",
  );
  const prefixes = [...loop.matchAll(/prefix: "([A-Z]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  const suffixes = [
    ...loop.matchAll(/^\s+([A-Z_]+): "\w+",$/gm),
    ...loop.matchAll(/\$\{role\.prefix\}_([A-Z_]+)/g),
  ].map((m) => m[1] ?? "");
  expect(prefixes).toEqual(["RECONCILER", "SCHEDULER"]);
  for (const suffix of suffixes) {
    names.delete(suffix);
    for (const prefix of prefixes) names.add(`${prefix}_${suffix}`);
  }
  return names;
}

function shellSettings(): Set<string> {
  const names = new Set<string>();
  for (const file of [...scan("infra/*.yml"), ...scan("scripts/*.sh")]) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(SHELL_DEFAULTS)) {
      names.add(match[1] ?? "");
    }
  }
  return names;
}

describe("Operator settings", () => {
  const documented = (text: string, name: string) =>
    new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(text);

  test("every setting the code reads is in docs/operations.md", () => {
    const operations = readFileSync(join(root, "docs/operations.md"), "utf8");
    const names = codeSettings();
    // The scan still sees each of its three forms, and every exception.
    for (const name of [
      "HEARTBEAT_TTL_SEC",
      "WORKER_PIDS_LIMIT",
      "SCHEDULER_STATUS_FILE",
      ...Object.keys(NOT_SETTINGS),
    ]) {
      expect(names).toContain(name);
    }
    const missing = [...names]
      .filter((name) => !(name in NOT_SETTINGS))
      .filter((name) => !documented(operations, name))
      .sort();
    expect(missing).toEqual([]);
  });

  test("every value compose or a script takes from the shell is in docs/", () => {
    const docs = scan("docs/**/*.md")
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    const names = shellSettings();
    expect(names).toContain("API_MEMORY_MB");
    const missing = [...names].filter((name) => !documented(docs, name)).sort();
    expect(missing).toEqual([]);
  });
});
