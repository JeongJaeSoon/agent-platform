import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(
  import.meta.dir,
  "..",
  ".github",
  "scripts",
  "forbidden-terms.ts",
);

// Synthetic entries only. They are not real forbidden terms, and the real list never appears here.
const SYNTHETIC = "zz-synthetic-alpha\n^zz-synthetic-beta [0-9]+$\n";
const HIT_TEXT = "contains ZZ-Synthetic-Alpha inside";

let root: string;
let binDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`git ${args[0]} failed`);
  return out.trim();
}

async function makeRepo(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  for (const [path, body] of Object.entries(files))
    await writeFile(join(dir, path), body);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base commit");
  return dir;
}

async function commit(
  dir: string,
  message: string,
  files: Record<string, string> = {},
): Promise<string> {
  for (const [path, body] of Object.entries(files))
    await writeFile(join(dir, path), body);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

async function run(cwd: string, env: Record<string, string>) {
  const clean = { ...process.env } as Record<string, string>;
  for (const key of [
    "FORBIDDEN_TERMS",
    "PR_NUMBER",
    "BASE_SHA",
    "BASE_REF",
    "HEAD_SHA",
    "FORK_PR",
  ])
    delete clean[key];
  const p = Bun.spawn(["bun", script], {
    cwd,
    env: {
      ...clean,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: stdout + stderr };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forbidden-terms-"));
  binDir = join(root, "bin");
  await mkdir(binDir);
  // Fake `gh`: prints the PR text held in $FAKE_PR_TEXT, or fails when FAKE_PR_FAIL is set.
  await writeFile(
    join(binDir, "gh"),
    '#!/bin/sh\n[ -n "$FAKE_PR_FAIL" ] && exit 4\nprintf "%s\\n" "$FAKE_PR_TEXT"\n',
  );
  await chmod(join(binDir, "gh"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("forbidden-terms", () => {
  test("a clean tree, range and PR text pass with zero counts", async () => {
    const dir = await makeRepo("clean", { "a.txt": "nothing here\n" });
    const base = await git(dir, "rev-parse", "HEAD");
    const head = await commit(dir, "second commit");
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: base,
      HEAD_SHA: head,
      PR_NUMBER: "7",
      FAKE_PR_TEXT: "title\nbody",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("tree: 0");
    expect(r.out).toContain("commit messages: 0");
    expect(r.out).toContain("PR title and body: 0");
  });

  test("a tree hit fails and the log has counts only", async () => {
    const dir = await makeRepo("tree", {
      "secret-named-file.txt": `${HIT_TEXT}\n`,
    });
    const r = await run(dir, { FORBIDDEN_TERMS: SYNTHETIC });
    expect(r.code).toBe(1);
    expect(r.out).toContain("tree: 1");
    expectNoLeak(r.out);
    expect(r.out).not.toContain("secret-named-file");
  });

  test("a commit message hit in the run range fails; one before the range is ignored", async () => {
    const dir = await makeRepo("msg", { "a.txt": "ok\n" });
    await commit(dir, `old ${HIT_TEXT}`);
    const base = await git(dir, "rev-parse", "HEAD");
    const hitHead = await commit(dir, `new ${HIT_TEXT}`);
    const cleanHead = await commit(dir, "fine");
    const bad = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: base,
      HEAD_SHA: hitHead,
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("commit messages: 1");
    expectNoLeak(bad.out);
    expect(bad.out).not.toContain(hitHead.slice(0, 7));
    const ok = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: cleanHead,
      HEAD_SHA: cleanHead,
    });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("commit messages: 0");
  });

  test("a push without a usable before scans the head commit only", async () => {
    const dir = await makeRepo("zero", { "a.txt": "ok\n" });
    await commit(dir, `old ${HIT_TEXT}`);
    const head = await commit(dir, "fine");
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      BASE_SHA: "0".repeat(40),
      HEAD_SHA: head,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("commit messages: 0");
  });

  test("a PR title or body hit fails with a count only", async () => {
    const dir = await makeRepo("pr", { "a.txt": "ok\n" });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      PR_NUMBER: "7",
      FAKE_PR_TEXT: `title\nbody ${HIT_TEXT}`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("PR title and body: 1");
    expectNoLeak(r.out);
  });

  test("matching is case-insensitive and honors the ERE anchors", async () => {
    const dir = await makeRepo("ere", { "a.txt": "ZZ-SYNTHETIC-BETA 42\n" });
    expect((await run(dir, { FORBIDDEN_TERMS: SYNTHETIC })).code).toBe(1);
    const miss = await makeRepo("ere2", {
      "a.txt": "x ZZ-SYNTHETIC-BETA 42\n",
    });
    expect(
      (await run(miss, { FORBIDDEN_TERMS: "^zz-synthetic-beta [0-9]+$\n" }))
        .code,
    ).toBe(0);
  });

  test("an empty or missing list fails closed, with a separate message for a fork", async () => {
    const dir = await makeRepo("nolist", { "a.txt": "ok\n" });
    const empty = await run(dir, { FORBIDDEN_TERMS: "\n  \n" });
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("::error::");
    const fork = await run(dir, { FORBIDDEN_TERMS: "", FORK_PR: "true" });
    expect(fork.code).toBe(1);
    expect(fork.out).toContain("fork");
  });

  test("an invalid pattern fails without quoting it", async () => {
    const dir = await makeRepo("bad", { "a.txt": "ok\n" });
    const r = await run(dir, { FORBIDDEN_TERMS: "zz-synthetic-broken(\n" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("zz-synthetic-broken");
  });

  test("an API failure fails with fixed text", async () => {
    const dir = await makeRepo("api", { "a.txt": "ok\n" });
    const r = await run(dir, {
      FORBIDDEN_TERMS: SYNTHETIC,
      PR_NUMBER: "7",
      FAKE_PR_FAIL: "1",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not read the PR title and body");
  });
});

function expectNoLeak(out: string) {
  expect(out.toLowerCase()).not.toContain("synthetic");
  expect(out).not.toContain(HIT_TEXT);
}
