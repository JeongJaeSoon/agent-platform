import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  restoreCheckpointTree,
  stageCheckpointBundle,
  stagedClaudeMd,
} from "./checkpoint-restore.ts";
import { GitResourceLimitError } from "./workspace.ts";
import {
  CHECKPOINT_WORKTREE_REF,
  captureWorkspace,
  type InstructionsPin,
  type WorkspaceCapture,
} from "./workspace-capture.ts";

let scratch: string;
let root: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-246-restore-"));
  root = join(scratch, "workspace");
  await mkdir(root);
  await git(root, "init", "--quiet", "--initial-branch=main");
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout;
}

async function commitFiles(files: Record<string, string>): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "commit");
  return (await git(root, "rev-parse", "HEAD")).trim();
}

async function captured(
  from = root,
  instructions?: InstructionsPin,
): Promise<WorkspaceCapture> {
  const result = await captureWorkspace({
    root: from,
    signal: new AbortController().signal,
    ...(instructions === undefined ? {} : { instructions }),
  });
  if (result.status !== "captured") throw new Error(result.reason);
  return result.capture;
}

async function stage(capture: WorkspaceCapture, name = "staged.git") {
  const bundle = join(scratch, `${name}.bundle`);
  await writeFile(bundle, capture.bundle);
  return stageCheckpointBundle({
    bundle,
    gitCommit: capture.gitCommit,
    repository: join(scratch, name),
    signal: new AbortController().signal,
  });
}

/** A second root, holding what a previous execution left behind. */
async function staleRoot(): Promise<string> {
  const target = join(scratch, "restored");
  await mkdir(join(target, ".git", "hooks"), { recursive: true });
  await writeFile(join(target, ".git", "hooks", "post-checkout"), "exit 1\n");
  await writeFile(join(target, "written-after-the-checkpoint.txt"), "stale\n");
  return target;
}

async function restore(
  capture: WorkspaceCapture,
  signal = new AbortController().signal,
): Promise<string> {
  const target = await staleRoot();
  await restoreCheckpointTree({
    origin: "https://git.example.test/acme/app.git",
    root: target,
    signal,
    staged: await stage(capture),
  });
  return target;
}

describe("restoring a captured checkout", () => {
  test("puts back the branch, HEAD, and the uncommitted edits as uncommitted", async () => {
    const head = await commitFiles({
      ".gitignore": "build/\n",
      "a.txt": "a\n",
      "gone.txt": "gone\n",
      "run.sh": "#!/bin/sh\n",
    });
    await writeFile(join(root, "a.txt"), "edited\n");
    await rm(join(root, "gone.txt"));
    await chmod(join(root, "run.sh"), 0o755);
    await mkdir(join(root, "build"));
    // Ignored, but staged anyway: only the index says it belongs.
    await writeFile(join(root, "build", "forced.txt"), "forced\n");
    await git(root, "add", "--force", "build/forced.txt");
    const first = await captured();

    const restored = await restore(first);

    expect((await git(restored, "symbolic-ref", "HEAD")).trim()).toBe(
      "refs/heads/main",
    );
    expect((await git(restored, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await readFile(join(restored, "a.txt"), "utf8")).toBe("edited\n");
    expect(existsSync(join(restored, "gone.txt"))).toBe(false);
    expect((await stat(join(restored, "run.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(restored, "build", "forced.txt"), "utf8")).toBe(
      "forced\n",
    );
    // Nothing the previous execution left survives, its hooks included.
    expect(existsSync(join(restored, "written-after-the-checkpoint.txt"))).toBe(
      false,
    );
    expect(existsSync(join(restored, ".git", "hooks", "post-checkout"))).toBe(
      false,
    );
    expect((await git(restored, "diff", "HEAD", "--name-status")).trim()).toBe(
      (await git(root, "diff", "HEAD", "--name-status")).trim(),
    );
    expect(await git(restored, "diff", "--cached", "--name-only")).toBe("");
    expect((await git(restored, "remote", "get-url", "origin")).trim()).toBe(
      "https://git.example.test/acme/app.git",
    );
    expect(await git(restored, "for-each-ref", "refs/restore/")).toBe("");
    // The next capture pins the same tree, the ignored staged file with it.
    const second = await stage(await captured(restored), "second.git");
    expect(
      (
        await git(
          join(scratch, "second.git"),
          "rev-parse",
          `${second.worktree}^{tree}`,
        )
      ).trim(),
    ).toBe(
      (
        await git(
          join(scratch, "staged.git"),
          "rev-parse",
          `${first.gitCommit}^{tree}`,
        )
      ).trim(),
    );
  });

  test("leaves a HEAD that was detached detached", async () => {
    const head = await commitFiles({ "a.txt": "a\n" });
    await git(root, "checkout", "--quiet", "--detach");

    const restored = await restore(await captured());

    expect((await git(restored, "rev-parse", "HEAD")).trim()).toBe(head);
    await expect(
      git(restored, "symbolic-ref", "--quiet", "HEAD"),
    ).rejects.toThrow();
  });

  test("clears a root holding more names than one pass reads", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const capture = await captured();
    const target = await staleRoot();
    for (let index = 0; index < 1_100; index += 1) {
      await writeFile(join(target, `stale-${index}`), "");
    }

    await restoreCheckpointTree({
      origin: "https://git.example.test/acme/app.git",
      root: target,
      signal: new AbortController().signal,
      staged: await stage(capture),
    });

    expect((await readdir(target)).sort()).toEqual([".git", "a.txt"]);
  });

  test("refuses a root that is a link, before removing anything behind it", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const capture = await captured();
    const outside = await staleRoot();
    const link = join(scratch, "linked-root");
    await symlink(outside, link);

    await expect(
      restoreCheckpointTree({
        origin: "https://git.example.test/acme/app.git",
        root: link,
        signal: new AbortController().signal,
        staged: await stage(capture),
      }),
    ).rejects.toThrow("is not a directory");
    expect(
      await readFile(join(outside, "written-after-the-checkpoint.txt"), "utf8"),
    ).toBe("stale\n");
  });

  test("touches nothing once stopped before the first removal", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const capture = await captured();
    const target = await staleRoot();
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));

    await expect(
      restoreCheckpointTree({
        origin: "https://git.example.test/acme/app.git",
        root: target,
        signal: stopped.signal,
        staged: await stage(capture),
      }),
    ).rejects.toThrow("stopped");
    expect(
      await readFile(join(target, "written-after-the-checkpoint.txt"), "utf8"),
    ).toBe("stale\n");
  });

  test("fails, rather than taking the worker down, when git runs out of its limits", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const staged = await stage(await captured());
    const target = await staleRoot();
    // The real git, except that `read-tree` dies the way RLIMIT_FSIZE kills
    // it when a file it writes grows past the limit.
    const real = Bun.which("git");
    const bin = join(scratch, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nfor arg; do [ "$arg" = read-tree ] && kill -s XFSZ $$; done\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      await expect(
        restoreCheckpointTree({
          origin: "https://git.example.test/acme/app.git",
          root: target,
          signal: new AbortController().signal,
          staged,
        }),
      ).rejects.toThrow(new GitResourceLimitError("SIGXFSZ"));
    } finally {
      process.env.PATH = path;
    }
  }, 30_000);
});

describe("staging a checkpoint bundle", () => {
  test("reads CLAUDE.md from the pinned instructions commit, not from HEAD", async () => {
    const pinned = await commitFiles({ "CLAUDE.md": "rules as fetched\n" });
    await commitFiles({ "CLAUDE.md": "rules the engine rewrote\n" });

    const staged = await stage(await captured(root, { commit: pinned }));

    expect(staged.instructions).toBe(pinned);
    expect(await stagedClaudeMd(staged, new AbortController().signal)).toEqual({
      kind: "text",
      text: "rules as fetched\n",
    });
  });

  test("a checkpoint without an instructions commit is refused for CLAUDE.md, not read as having none", async () => {
    await commitFiles({ "CLAUDE.md": "rules\n" });

    const staged = await stage(await captured());

    expect(staged.instructions).toBeNull();
    expect(
      await stagedClaudeMd(staged, new AbortController().signal),
    ).toMatchObject({ kind: "refused" });
  });

  test("refuses a bundle whose worktree commit is not the manifest's", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const capture = await captured();

    await expect(
      stage({ ...capture, gitCommit: "f".repeat(40) }),
    ).rejects.toThrow("not the manifest's");
  });

  test("refuses a bundle carrying a ref no capture writes", async () => {
    await commitFiles({ "a.txt": "a\n" });
    await git(root, "tag", "v1");
    const capture = await captured();
    // The same objects, bundled with one more ref.
    const repository = join(scratch, "extra.git");
    await git(scratch, "init", "--quiet", "--bare", repository);
    const bundle = join(scratch, "capture.bundle");
    await writeFile(bundle, capture.bundle);
    await git(repository, "fetch", "--quiet", bundle, "refs/*:refs/*");
    await git(repository, "update-ref", "refs/tags/extra", capture.gitCommit);
    await git(
      repository,
      "bundle",
      "create",
      "--quiet",
      join(scratch, "extra.bundle"),
      "--all",
    );

    await expect(
      stageCheckpointBundle({
        bundle: join(scratch, "extra.bundle"),
        gitCommit: capture.gitCommit,
        repository: join(scratch, "staged-extra.git"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("refs/tags/extra");
    expect(capture.gitCommit).toBe(
      (await git(repository, "rev-parse", CHECKPOINT_WORKTREE_REF)).trim(),
    );
  });
});
