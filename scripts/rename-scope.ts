// Renames the internal package scope @agent-platform/ to @werft-ai/ (94S-749).
// Usage: bun scripts/rename-scope.ts [--dry-run]
// Re-runnable: a second run changes nothing. Exits non-zero if references remain.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const TO = "@werft-ai/";
// The escaped form appears inside regex literals (e.g. /from\s+"@agent-platform\/contracts"/).
const REWRITES: [string, string][] = [
  ["@agent-platform/", TO],
  ["@agent-platform\\/", "@werft-ai\\/"],
];
// Broader than REWRITES so a form the rewrite misses still fails the check.
// The Gitea test account (agent@agent-platform.invalid) is a mail domain, not the scope.
const RESIDUAL = /@agent-platform(?!\.invalid)/;

// Without `line` the whole file is skipped; with it, only lines containing that text.
const EXCEPTIONS: {
  path: string;
  line?: string;
  reason: string;
}[] = [
  {
    path: "scripts/rename-scope.ts",
    reason: "the codemod has to name the old scope",
  },
];

// Edits the plain rewrite cannot make, applied to the rewritten text.
const FIXUPS: { path: string; from: string; to: string; reason: string }[] = [
  {
    path: "packages/ui/src/package.test.ts",
    from: '  "@werft-ai/contracts",\n  "@radix-ui/react-checkbox",\n  "@radix-ui/react-dialog",\n  "@radix-ui/react-radio-group",\n  "@radix-ui/react-slot",\n  "@radix-ui/react-tabs",\n',
    to: '  "@radix-ui/react-checkbox",\n  "@radix-ui/react-dialog",\n  "@radix-ui/react-radio-group",\n  "@radix-ui/react-slot",\n  "@radix-ui/react-tabs",\n  "@werft-ai/contracts",\n',
    reason: "the allowed dependency list is compared with a sorted list",
  },
];

const KINDS = [
  "package.json",
  "lockfile",
  "tsconfig",
  "source",
  "docs",
  "config",
  "exclusive (.github, docker, compose)",
] as const;
type Kind = (typeof KINDS)[number];

function kindOf(path: string): Kind {
  const name = basename(path);
  if (
    path.startsWith(".github/") ||
    name.startsWith("Dockerfile") ||
    name === ".dockerignore" ||
    /compose[^/]*\.ya?ml$/.test(name)
  ) {
    return "exclusive (.github, docker, compose)";
  }
  if (name === "package.json") return "package.json";
  if (name === "bun.lock") return "lockfile";
  if (/^tsconfig.*\.json$/.test(name)) return "tsconfig";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(name)) return "source";
  if (/\.(md|mdx)$/.test(name)) return "docs";
  return "config";
}

function excepted(path: string, line?: string): boolean {
  return EXCEPTIONS.some(
    (e) =>
      e.path === path &&
      (e.line === undefined || line?.includes(e.line) === true),
  );
}

function rewrite(path: string, text: string): string {
  let out = text
    .split("\n")
    .map((line) => {
      if (excepted(path, line)) return line;
      let next = line;
      for (const [from, to] of REWRITES) next = next.split(from).join(to);
      return next;
    })
    .join("\n");
  for (const fixup of FIXUPS) {
    if (fixup.path !== path) continue;
    if (!out.includes(fixup.from) && !out.includes(fixup.to)) {
      throw new Error(
        `fixup for ${path} matches neither its old nor its new text; update FIXUPS`,
      );
    }
    out = out.split(fixup.from).join(fixup.to);
  }
  return out;
}

function git(root: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// Tracked plus untracked-but-not-ignored files: never .git, node_modules or other ignored output.
function listFiles(root: string): string[] {
  return git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter(Boolean);
}

function readBytes(root: string, path: string): Buffer | undefined {
  try {
    return readFileSync(join(root, path));
  } catch {
    return undefined; // deleted in the worktree but still in the index
  }
}

function readText(root: string, path: string): string | undefined {
  const buf = readBytes(root, path);
  return buf?.includes(0) ? undefined : buf?.toString("utf8");
}

function residuals(root: string, contents: Map<string, string>): string[] {
  const hits: string[] = [];
  for (const path of listFiles(root)) {
    if (excepted(path)) continue;
    const text = contents.get(path) ?? readText(root, path);
    if (text === undefined) {
      // Binary files are not rewritten, so any reference in one is a residual.
      const raw = readBytes(root, path)?.toString("latin1") ?? "";
      if (RESIDUAL.test(raw)) hits.push(`${path}: (binary file)`);
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (RESIDUAL.test(line) && !excepted(path, line))
        hits.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

function run(cmd: string, args: string[], root: string, shown = args): void {
  console.log(`$ ${cmd} ${shown.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${cmd} exited with ${r.status}`);
    process.exit(1);
  }
}

function pinnedBunVersion(root: string): string | undefined {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return /^bun@(.+)$/.exec(pkg.packageManager ?? "")?.[1];
}

const dryRun = process.argv.includes("--dry-run");
const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();

const changed = new Map<string, string>();
for (const path of listFiles(root)) {
  if (excepted(path)) continue;
  const text = readText(root, path);
  if (text === undefined) continue;
  const next = rewrite(path, text);
  if (next !== text) changed.set(path, next);
}

const byKind = new Map<Kind, string[]>();
for (const path of changed.keys()) {
  const kind = kindOf(path);
  byKind.set(kind, [...(byKind.get(kind) ?? []), path]);
}
console.log(`${dryRun ? "would change" : "changed"}: ${changed.size} files`);
for (const kind of KINDS) {
  console.log(`  ${kind}: ${byKind.get(kind)?.length ?? 0}`);
}
for (const kind of [
  "exclusive (.github, docker, compose)",
  "lockfile",
  "tsconfig",
] as const) {
  for (const path of byKind.get(kind) ?? [])
    console.log(`    ${kind}: ${path}`);
}
for (const fixup of FIXUPS) {
  console.log(`  fixup ${fixup.path}: ${fixup.reason}`);
}

if (!dryRun) {
  for (const [path, text] of changed) writeFileSync(join(root, path), text);
  // Install and format run on every write-mode run, so a run interrupted after the
  // rewrite is finished by the next one. Both are no-ops on an already renamed tree.
  if (listFiles(root).includes("bun.lock")) {
    const pinned = pinnedBunVersion(root);
    if (pinned && Bun.version !== pinned) {
      console.error(
        `bun ${Bun.version} runs this script; package.json pins bun@${pinned}. Rerun with the pinned bun.`,
      );
      process.exit(1);
    }
    const before = readText(root, "bun.lock");
    run(process.execPath, ["install"], root);
    const after = readText(root, "bun.lock");
    console.log(`bun install changed bun.lock: ${after !== before}`);
  }
  // The shorter scope moves import order and line wrapping, so files holding it are reformatted.
  const renamed = new Map<string, string>();
  for (const path of listFiles(root)) {
    if (
      excepted(path) ||
      !/\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/.test(path)
    ) {
      continue;
    }
    const text = readText(root, path);
    if (text && REWRITES.some(([, to]) => text.includes(to)))
      renamed.set(path, text);
  }
  if (renamed.size > 0 && listFiles(root).includes("biome.json")) {
    const flags = [
      "check",
      "--write",
      "--linter-enabled=false",
      "--files-ignore-unknown=true",
      "--no-errors-on-unmatched",
    ];
    run(
      join(root, "node_modules/.bin/biome"),
      [...flags, ...renamed.keys()],
      root,
      [...flags, `<${renamed.size} files holding ${TO}>`],
    );
    const formatted = [...renamed].filter(
      ([path, text]) => readText(root, path) !== text,
    );
    console.log(`biome reformatted: ${formatted.length} files`);
  }
}

console.log("residual check (exceptions below are skipped):");
for (const e of EXCEPTIONS) console.log(`  exception ${e.path}: ${e.reason}`);
const hits = residuals(root, dryRun ? changed : new Map());
if (hits.length > 0) {
  console.log(`  FAIL: ${hits.length} reference(s) to the old scope remain`);
  for (const hit of hits) console.log(`    ${hit}`);
  process.exit(1);
}
console.log("  OK: 0 references to the old scope remain");
