import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ClaimGit,
  type ClaimGitAuthor,
  ENGINE_COAUTHOR_EMAILS,
} from "@werft-ai/contracts";
import {
  attributionMismatches,
  COMMIT_FACTS_FORMAT,
  parseCommitFacts,
} from "@werft-ai/runtime-core";
import { GIT_IDENTITY_PATH, writeGitTrailers } from "./git-trailers.ts";

const TOOL = resolve(import.meta.dir, "../git-hooks/werft-repair-attribution");
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_URL = `https://console.example.com/sessions/${SESSION_ID}`;
const CO_AUTHOR = {
  name: "octocat",
  email: "583231+octocat@users.noreply.github.com",
};
const GIT: ClaimGit = { co_author: CO_AUTHOR, session_url: SESSION_URL };
const BOT: ClaimGitAuthor = {
  name: "werft-dev[bot]",
  email: "41898282+werft-dev[bot]@users.noreply.github.com",
};
const ENGINE_LINE = "Co-Authored-By: Claude <noreply@anthropic.com>";

let root: string;
let home: string;
let repo: string;

function env(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    // The worker's own git runs without system config; the tool lifts that.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: join(root, "gitconfig"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
}

function git(args: string[], extra: Record<string, string> = {}) {
  const run = Bun.spawnSync(["git", ...args], { cwd: repo, env: env(extra) });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  }
  return run.stdout.toString().trim();
}

let counter = 0;
/** A commit by whoever `who` names, with no hook: the way attribution goes wrong. */
function commit(
  message: string,
  who: { name: string; email: string } = {
    name: "someone",
    email: "someone@example.com",
  },
): string {
  counter += 1;
  writeFileSync(join(repo, `f${counter}.txt`), `${message}\n`);
  git(["add", `f${counter}.txt`]);
  git(
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      `user.name=${who.name}`,
      "-c",
      `user.email=${who.email}`,
      "commit",
      "-q",
      "-m",
      message,
    ],
    {
      GIT_COMMITTER_DATE: `2026-01-01T00:00:${String(counter).padStart(2, "0")}Z`,
    },
  );
  return git(["rev-parse", "HEAD"]);
}

function repair(protectedShas: string[] = []) {
  const file = join(root, "protected");
  writeFileSync(file, `${protectedShas.join("\n")}\n`);
  const run = Bun.spawnSync(["sh", TOOL, repo, file], { env: env() });
  return {
    code: run.exitCode,
    out: run.stdout.toString().trim(),
    err: run.stderr.toString(),
  };
}

const remoteTracking = (sha: string, name = "origin/main") =>
  git(["update-ref", `refs/remotes/${name}`, sha]);

function facts(rev: string) {
  const out = git(["log", `--format=${COMMIT_FACTS_FORMAT}`, rev, "-1"]);
  return parseCommitFacts(`${out}\x1e`)?.[0];
}

function verdict(range: string[]) {
  const commits = range
    .map((sha) => facts(sha))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);
  return attributionMismatches(
    commits,
    [
      {
        author: BOT,
        coAuthor: CO_AUTHOR,
        agentSession: SESSION_URL,
      },
    ],
    [...ENGINE_COAUTHOR_EMAILS],
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "werft-repair-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(
    join(root, "gitconfig"),
    `[user]\n\tname = Werft\n\temail = noreply@werft.invalid\n[include]\n\tpath = ~/${GIT_IDENTITY_PATH}\n[init]\n\tdefaultBranch = main\n`,
  );
  await writeGitTrailers(home, {
    session_id: SESSION_ID,
    git: GIT,
    git_author: BOT,
    git_strip: ENGINE_COAUTHOR_EMAILS,
  });
  git(["init", "-q", "-b", "main"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("werft-repair-attribution", () => {
  test("remakes a wrong commit with the claim's identity, trailers and the same tree", () => {
    const base = commit("base");
    remoteTracking(base);
    const wrong = commit(`feat: x\n\n${ENGINE_LINE}`);
    const tree = git(["rev-parse", `${wrong}^{tree}`]);
    const result = repair();
    expect(result.code).toBe(0);
    const [word, from, to] = result.out.split(" ");
    expect([word, from]).toEqual(["repaired", wrong]);
    expect(git(["rev-parse", "HEAD"])).toBe(to as string);
    expect(git(["rev-parse", "HEAD^{tree}"])).toBe(tree);
    expect(git(["rev-parse", "HEAD^"])).toBe(base);
    expect(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      `${BOT.name} <${BOT.email}>|${BOT.name} <${BOT.email}>`,
    );
    expect(git(["log", "-1", "--format=%B"])).toBe(
      [
        "feat: x",
        "",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
      ].join("\n"),
    );
    expect(verdict([git(["rev-parse", "HEAD"])])).toEqual([]);
  });

  test("a commit that is already right is left alone, and a second run is clean", () => {
    remoteTracking(commit("base"));
    commit("feat: y");
    expect(repair().out).toMatch(/^repaired /);
    const tip = git(["rev-parse", "HEAD"]);
    expect(repair()).toMatchObject({ code: 0, out: "clean" });
    expect(git(["rev-parse", "HEAD"])).toBe(tip);
  });

  test("a commit with a git -c user.name override is fixed too", () => {
    remoteTracking(commit("base"));
    commit("feat: z", { name: "x", email: "x@example.com" });
    expect(repair().code).toBe(0);
    expect(git(["log", "-1", "--format=%an"])).toBe(BOT.name);
  });

  test("a chain is remade in order and the first remade commit builds on the boundary", () => {
    const base = commit("base");
    remoteTracking(base);
    const a = commit("a");
    const b = commit("b");
    expect(repair().code).toBe(0);
    const newB = git(["rev-parse", "HEAD"]);
    const newA = git(["rev-parse", "HEAD^"]);
    expect(newA).not.toBe(a);
    expect(newB).not.toBe(b);
    expect(git(["rev-parse", `${newA}^`])).toBe(base);
  });

  test("commits the server protects are not remade, though no remote ref holds them", () => {
    remoteTracking(commit("base"));
    const pushed = commit("already pushed");
    const q = commit("q");
    expect(repair([pushed]).code).toBe(0);
    // P stays; only Q is remade on top of it, so the next push fast-forwards.
    expect(git(["rev-parse", "HEAD^"])).toBe(pushed);
    expect(git(["rev-parse", "HEAD"])).not.toBe(q);
  });

  test("without that protection the same history would have been remade (what the list is for)", () => {
    remoteTracking(commit("base"));
    const pushed = commit("already pushed");
    commit("q");
    repair();
    expect(git(["rev-parse", "HEAD^"])).not.toBe(pushed);
  });

  test("a protected commit this repository lacks is ignored", () => {
    remoteTracking(commit("base"));
    commit("q");
    expect(repair(["f".repeat(40)]).code).toBe(0);
  });

  test("a merge keeps its other parent as it was: the pushed P and the default branch B", () => {
    const base = commit("base");
    remoteTracking(base);
    const p = commit("p");
    git(["checkout", "-q", "-b", "other", base]);
    const b = commit("b on default", { name: "human", email: "h@example.com" });
    remoteTracking(b, "origin/other");
    git(["checkout", "-q", "main"]);
    const q = commit("q");
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@x",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge b",
      b,
    ]);
    const m = git(["rev-parse", "HEAD"]);
    const result = repair([p]);
    expect(result.code).toBe(0);
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(
      " ",
    );
    expect(parents).toHaveLength(3);
    // First parent: Q remade on P (not remade); second parent: B as it was.
    expect(parents[2]).toBe(b);
    expect(git(["rev-parse", `${parents[1]}^`])).toBe(p);
    expect(git(["rev-parse", "HEAD"])).not.toBe(m);
    expect(git(["rev-parse", "HEAD^{tree}"])).toBe(
      git(["rev-parse", `${m}^{tree}`]),
    );
    void q;
  });

  test("an octopus merge keeps every other parent", () => {
    const base = commit("base");
    remoteTracking(base);
    git(["checkout", "-q", "-b", "o1", base]);
    const o1 = commit("o1", { name: "h", email: "h@e" });
    git(["checkout", "-q", "-b", "o2", base]);
    const o2 = commit("o2", { name: "h", email: "h@e" });
    remoteTracking(o1, "origin/o1");
    remoteTracking(o2, "origin/o2");
    git(["checkout", "-q", "main"]);
    commit("q");
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@x",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "octopus",
      o1,
      o2,
    ]);
    expect(repair().code).toBe(0);
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(
      " ",
    );
    expect(parents.slice(2)).toEqual([o1, o2]);
  });

  test("a merge of two commits in the range writes nothing and says nested_merge", () => {
    const base = commit("base");
    remoteTracking(base);
    git(["checkout", "-q", "-b", "side", base]);
    commit("side work");
    git(["checkout", "-q", "main"]);
    commit("main work");
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@x",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge side",
      "side",
    ]);
    const before = git(["rev-parse", "HEAD"]);
    const result = repair();
    expect(result.code).toBe(2);
    expect(result.out).toMatch(/^nested_merge [0-9a-f]{40}$/);
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });

  test("uncommitted and untracked changes are untouched", () => {
    remoteTracking(commit("base"));
    commit("q");
    writeFileSync(join(repo, "f1.txt"), "edited, not committed\n");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    git(["add", "untracked.txt"]);
    writeFileSync(join(repo, "untracked2.txt"), "never added\n");
    const before = git(["status", "--porcelain"]);
    expect(repair().code).toBe(0);
    expect(git(["status", "--porcelain"])).toBe(before);
    expect(readFileSync(join(repo, "f1.txt"), "utf8")).toBe(
      "edited, not committed\n",
    );
  });

  test("a detached HEAD moves, not a branch", () => {
    remoteTracking(commit("base"));
    const q = commit("q");
    git(["checkout", "-q", "--detach"]);
    const result = repair();
    expect(result.out).toMatch(/^repaired /);
    expect(git(["rev-parse", "HEAD"])).not.toBe(q);
    expect(git(["rev-parse", "main"])).toBe(q);
  });

  test("a failure writes nothing: no identity means the branch is unchanged", () => {
    remoteTracking(commit("base"));
    const q = commit("q");
    writeFileSync(join(root, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
    expect(repair().code).toBe(1);
    expect(git(["rev-parse", "HEAD"])).toBe(q);
  });

  test("dates are kept, so a commit already right keeps its hash", () => {
    remoteTracking(commit("base"));
    commit("q");
    repair();
    const date = git(["log", "-1", "--format=%cI"]);
    repair();
    expect(git(["log", "-1", "--format=%cI"])).toBe(date);
    expect(date).toContain("2026-01-01");
  });

  test("a local replace ref does not change the tree the repair keeps", () => {
    remoteTracking(commit("base"));
    const wrong = commit("feat: replaced");
    const tree = git(["rev-parse", `${wrong}^{tree}`]);
    const emptyTree = git(["hash-object", "-t", "tree", "/dev/null"]);
    const decoy = git(["commit-tree", emptyTree, "-m", "decoy"], {
      GIT_AUTHOR_NAME: "d",
      GIT_AUTHOR_EMAIL: "d@d",
      GIT_COMMITTER_NAME: "d",
      GIT_COMMITTER_EMAIL: "d@d",
    });
    git(["replace", wrong, decoy]);
    expect(repair().out).toMatch(/^repaired /);
    expect(
      git(["rev-parse", "HEAD^{tree}"], { GIT_NO_REPLACE_OBJECTS: "1" }),
    ).toBe(tree);
  });

  test("a reference-transaction hook in the repository does not run", () => {
    remoteTracking(commit("base"));
    commit("feat: hooked");
    const marker = join(root, "hook-ran");
    const hook = join(repo, ".git", "hooks", "reference-transaction");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    expect(repair().out).toMatch(/^repaired /);
    expect(Bun.file(marker).size).toBe(0);
    expect(Bun.spawnSync(["test", "-e", marker]).exitCode).toBe(1);
  });

  test("a merge whose other parent is a right commit inside the range is kept, not nested", () => {
    const base = commit("base");
    remoteTracking(base);
    repair();
    git(["checkout", "-q", "-b", "side", base]);
    commit("side work");
    expect(repair().out).toMatch(/^repaired /);
    const side = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "main"]);
    commit("main work");
    expect(repair().out).toMatch(/^repaired /);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      `user.name=${BOT.name}`,
      "-c",
      `user.email=${BOT.email}`,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      `merge side\n\nCo-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>\nAgent-Session: ${SESSION_URL}`,
      "side",
    ]);
    const tip = git(["rev-parse", "HEAD"]);
    const result = repair();
    expect(result).toMatchObject({ code: 0, out: "clean" });
    expect(git(["rev-parse", "HEAD"])).toBe(tip);
    expect(git(["rev-parse", "HEAD^2"])).toBe(side);
  });
});
