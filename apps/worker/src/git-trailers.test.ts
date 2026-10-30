import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ClaimGit } from "@werft-ai/contracts";
import {
  GIT_TRAILERS_PATH,
  gitTrailerLines,
  writeGitTrailers,
} from "./git-trailers.ts";

const HOOK = resolve(import.meta.dir, "../git-hooks/werft-hook");
const CO_AUTHOR = {
  name: "octocat",
  email: "583231+octocat@users.noreply.github.com",
};
const SESSION_URL =
  "https://console.example.com/sessions/11111111-1111-4111-8111-111111111111";
const LINKED: ClaimGit = { co_author: CO_AUTHOR, session_url: SESSION_URL };

let root: string;
let home: string;
let repo: string;

/** git as the image runs it for the engine: the hook directory from config. */
function git(args: string[], options: { allowFail?: boolean } = {}) {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    },
  });
  if (!options.allowFail && run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  }
  return { code: run.exitCode, out: run.stdout.toString() };
}

const lastMessage = () => git(["log", "-1", "--format=%B"]).out.trimEnd();

function repoHook(name: string, body: string) {
  const path = join(repo, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "werft-hook-"));
  home = join(root, "home");
  repo = join(root, "repo");
  const hooks = join(root, "hooks");
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(hooks);
  for (const name of ["commit-msg", "pre-commit", "prepare-commit-msg"]) {
    symlinkSync(HOOK, join(hooks, name));
  }
  writeFileSync(
    join(root, "gitconfig"),
    `[user]\n\tname = Werft\n\temail = noreply@werft.invalid\n[core]\n\thooksPath = ${hooks}\n[init]\n\tdefaultBranch = main\n`,
  );
  git(["init", "-q"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the commit-msg hook", () => {
  test("adds Co-authored-by and Agent-Session once, however often the commit is amended", async () => {
    await writeGitTrailers(home, LINKED);
    git(["commit", "-q", "--allow-empty", "-m", "Fix the thing"]);
    git(["commit", "-q", "--amend", "--allow-empty", "--no-edit"]);
    git(["commit", "-q", "--amend", "--allow-empty", "-m", lastMessage()]);
    expect(lastMessage()).toBe(
      [
        "Fix the thing",
        "",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
      ].join("\n"),
    );
  });

  test("keeps the trailers a message already has and does not repeat one", async () => {
    await writeGitTrailers(home, LINKED);
    const message = [
      "Fix the thing",
      "",
      "Body text.",
      "",
      "Signed-off-by: Ada <ada@example.com>",
      `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
      "Co-authored-by: Grace <grace@example.com>",
    ].join("\n");
    git(["commit", "-q", "--allow-empty", "-m", message]);
    expect(lastMessage()).toBe(`${message}\nAgent-Session: ${SESSION_URL}`);
  });

  test("with co_author null only Agent-Session is added", async () => {
    await writeGitTrailers(home, { co_author: null, session_url: SESSION_URL });
    git(["commit", "-q", "--allow-empty", "-m", "Agent work"]);
    expect(lastMessage()).toBe(`Agent work\n\nAgent-Session: ${SESSION_URL}`);
  });

  test("without a trailers file the message is left as written", async () => {
    await writeGitTrailers(home, undefined);
    git(["commit", "-q", "--allow-empty", "-m", "Plain"]);
    expect(lastMessage()).toBe("Plain");
  });

  test("passes a line as one argv: shell text in it is never run", () => {
    const marker = join(root, "ran");
    mkdirSync(join(home, ".werft"));
    writeFileSync(
      join(home, GIT_TRAILERS_PATH),
      `Agent-Session: $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}\n`,
    );
    git(["commit", "-q", "--allow-empty", "-m", "Quoted"]);
    expect(existsSync(marker)).toBe(false);
    expect(lastMessage()).toBe(
      `Quoted\n\nAgent-Session: $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}`,
    );
  });

  test("skips lines with a CR or another key", () => {
    mkdirSync(join(home, ".werft"));
    writeFileSync(
      join(home, GIT_TRAILERS_PATH),
      `Agent-Session: one\rSigned-off-by: forged <f@example.com>\nSigned-off-by: forged <f@example.com>\nReviewed-by: nobody\nAgent-Session: two\n`,
    );
    git(["commit", "-q", "--allow-empty", "-m", "Filtered"]);
    expect(lastMessage()).toBe("Filtered\n\nAgent-Session: two");
  });

  test("runs the repository's own hooks: theirs first, a refusal stops the commit", async () => {
    await writeGitTrailers(home, LINKED);
    repoHook("commit-msg", 'printf "\\nRepo-Hook: ran\\n" >>"$1"');
    git(["commit", "-q", "--allow-empty", "-m", "Chained"]);
    expect(lastMessage()).toBe(
      [
        "Chained",
        "",
        "Repo-Hook: ran",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
      ].join("\n"),
    );

    repoHook("pre-commit", "exit 1");
    const refused = git(["commit", "-q", "--allow-empty", "-m", "Refused"], {
      allowFail: true,
    });
    expect(refused.code).not.toBe(0);
    expect(lastMessage().startsWith("Chained")).toBe(true);
  });

  test("a hook the repository does not have is a no-op", async () => {
    await writeGitTrailers(home, LINKED);
    // prepare-commit-msg points at the dispatcher with no repository hook.
    git(["commit", "-q", "--allow-empty", "-m", "Quiet"]);
    expect(lastMessage().startsWith("Quiet\n\n")).toBe(true);
  });
});

describe("the trailers file", () => {
  test("holds one line per trailer the claim names", async () => {
    await writeGitTrailers(home, LINKED);
    expect(readFileSync(join(home, GIT_TRAILERS_PATH), "utf8")).toBe(
      `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>\nAgent-Session: ${SESSION_URL}\n`,
    );
  });

  test("is removed when the claim names none, so a later claim's absence adds nothing", async () => {
    await writeGitTrailers(home, LINKED);
    await writeGitTrailers(home, { co_author: null, session_url: null });
    expect(existsSync(join(home, GIT_TRAILERS_PATH))).toBe(false);
  });

  test("drops a value that could break a line", () => {
    expect(
      gitTrailerLines({
        co_author: { name: "octo\ncat", email: CO_AUTHOR.email },
        session_url: `${SESSION_URL}\rX`,
      }),
    ).toEqual([]);
  });
});
