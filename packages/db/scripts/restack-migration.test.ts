import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrationFolderProblems,
  readJournal,
} from "../src/migration-folder.ts";

// db:restack runs on git history, so each case builds it in a scratch
// repository holding a copy of this package: `fork` is where the branch left
// main, and a branch is committed as `git rebase` plus
// `git checkout --ours -- packages/db/migrations/meta` leaves it.
const packageDir = join(import.meta.dir, "..");
const repoRoot = join(packageDir, "../..");
const TIMEOUT_MS = 180_000;

let root: string;
let pkg: string;
let migrations: string;
let next: number;

function git(...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=restack-test",
      "-c",
      "user.email=restack-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function bun(...args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: pkg,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function addTable(name: string): void {
  appendFileSync(
    join(pkg, "src/schema.ts"),
    `\nexport const ${name} = pgTable("${name}", { id: text().primaryKey() });\n`,
  );
}

function generate(name: string): string {
  const result = bun("run", "db:generate", "--name", name);
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const tag = readJournal(migrations).at(-1)?.tag ?? "";
  expect(tag).toEndWith(`_${name}`);
  return tag;
}

const tag = (index: number, name: string) =>
  `${String(index).padStart(4, "0")}_${name}`;

// schema.ts is edited between calls, so each import is a fresh module.
async function problems(): Promise<string[]> {
  const schema = await import(`${join(pkg, "src/schema.ts")}?${Date.now()}`);
  return migrationFolderProblems(migrations, schema);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "restack-"));
  pkg = join(root, "packages/db");
  migrations = join(pkg, "migrations");
  for (const part of [
    "package.json",
    "drizzle.config.ts",
    "scripts",
    "src",
    "migrations",
  ]) {
    cpSync(join(packageDir, part), join(pkg, part), { recursive: true });
  }
  cpSync(join(repoRoot, "biome.json"), join(root, "biome.json"));
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
  // No trailing slash: git sees the symlink as a file, not a directory.
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  next = Number(readJournal(migrations).at(-1)?.tag.slice(0, 4)) + 1;
  git("init", "-q", "-b", "fork");
  git("add", ".");
  git("commit", "-qm", "fork");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("db:restack", () => {
  test(
    "moves a migration whose number main took since the fork to the next number",
    async () => {
      git("switch", "-qc", "collision-branch", "fork");
      addTable("restack_branch");
      const branchTag = generate("restack_branch");
      expect(branchTag).toBe(tag(next, "restack_branch"));
      git("add", ".");
      git("commit", "-qm", "branch");

      git("switch", "-qc", "collision-main", "fork");
      addTable("restack_main");
      expect(generate("restack_main")).toBe(tag(next, "restack_main"));
      git("add", ".");
      git("commit", "-qm", "main");

      git("switch", "-qc", "collision-rebased", "collision-main");
      addTable("restack_branch");
      const sql = git(
        "show",
        `collision-branch:packages/db/migrations/${branchTag}.sql`,
      );
      writeFileSync(join(migrations, `${branchTag}.sql`), `${sql}\n`);
      git("add", ".");
      git("commit", "-qm", "rebased");
      expect(await problems()).toContain(
        `${branchTag}.sql has no journal entry`,
      );

      const result = bun(
        "run",
        "scripts/restack-migration.ts",
        "--base",
        "collision-main",
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const moved = tag(next + 1, "restack_branch");
      expect(result.stdout).toContain(`${branchTag} -> ${moved}`);
      expect(
        readJournal(migrations)
          .slice(-2)
          .map((entry) => entry.tag),
      ).toEqual([tag(next, "restack_main"), moved]);
      expect(existsSync(join(migrations, `${branchTag}.sql`))).toBe(false);
      expect(await problems()).toEqual([]);
      git("add", ".");
      git("commit", "-qm", "restacked");
    },
    TIMEOUT_MS,
  );

  test(
    "renumbers a migration that skips numbers to the next one",
    async () => {
      git("switch", "-qc", "gap", "fork");
      addTable("restack_gap");
      const generated = generate("restack_gap");
      git("checkout", "fork", "--", "packages/db/migrations/meta");
      git("clean", "-fdq", "--", "packages/db/migrations/meta");
      const skipping = tag(next + 3, "restack_gap");
      renameSync(
        join(migrations, `${generated}.sql`),
        join(migrations, `${skipping}.sql`),
      );
      git("add", ".");
      git("commit", "-qm", "gap");
      expect(await problems()).toContain(
        `${skipping}.sql has no journal entry`,
      );

      const result = bun(
        "run",
        "scripts/restack-migration.ts",
        "--base",
        "fork",
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        `${skipping} -> ${tag(next, "restack_gap")}`,
      );
      expect(readJournal(migrations).at(-1)?.tag).toBe(
        tag(next, "restack_gap"),
      );
      expect(existsSync(join(migrations, `${skipping}.sql`))).toBe(false);
      expect(await problems()).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
