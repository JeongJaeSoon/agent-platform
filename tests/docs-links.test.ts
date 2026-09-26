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

// Setting names, found the way check.py found them for the feature map
// (94S-379): read off an environment object, or handed by name to a parser.
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
    const docs = scan("docs/*.md")
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    const names = shellSettings();
    expect(names).toContain("API_MEMORY_MB");
    const missing = [...names].filter((name) => !documented(docs, name)).sort();
    expect(missing).toEqual([]);
  });
});
