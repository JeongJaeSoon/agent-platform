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
import { readGitBundleHeader } from "@agent-platform/runtime-core";
import { createGitWorkspaceBundleVerifier } from "@agent-platform/storage";
import { createGitBundle } from "@agent-platform/testkit/git-bundle";

import {
  CheckpointBundleRefused,
  restoreCheckpointTree,
  stageCheckpointBundle,
  stagedClaudeMd,
} from "./checkpoint-restore.ts";
import { GitResourceLimitError } from "./workspace.ts";
import {
  type BundleBase,
  CHECKPOINT_WORKTREE_REF,
  captureWorkspace,
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
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
      // As `runGit` does. Otherwise `commit` detaches
      // `git maintenance run --auto`, whose cruft repack (git >= 2.54) can
      // race a later `gc --prune=now` and keep the commit it prunes (94S-412).
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "gc.auto",
      GIT_CONFIG_VALUE_1: "0",
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
  base?: BundleBase,
): Promise<WorkspaceCapture> {
  const result = await captureWorkspace({
    root: from,
    bundlePath: join(scratch, `capture-${crypto.randomUUID()}.bundle`),
    signal: new AbortController().signal,
    ...(instructions === undefined ? {} : { instructions }),
    ...(base === undefined ? {} : { base }),
  });
  if (result.status !== "captured") throw new Error(result.reason);
  return result.capture;
}

async function stage(capture: WorkspaceCapture, name = "staged.git") {
  return stageCheckpointBundle({
    bundle: capture.bundle.path,
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

  test("keeps only what the instructions commit reaches, which a capture still bundles once the engine pruned its own copy (94S-370)", async () => {
    const pinned = await commitFiles({ "CLAUDE.md": "rules\n" });
    const noise = () =>
      crypto.getRandomValues(new Uint8Array(256 * 1024)).join();
    await commitFiles({ "later.txt": noise() });
    await writeFile(join(root, "uncommitted.txt"), noise());
    await git(root, "add", "--intent-to-add", "uncommitted.txt");
    const capture = await captured(root, { commit: pinned });
    const later = (await git(root, "rev-parse", "HEAD:later.txt")).trim();
    const target = await staleRoot();
    const keep = join(target, ".agent-platform-restore-test");
    await mkdir(keep);
    const signal = new AbortController().signal;

    const { staged } = await restoreCheckpointTree({
      keep,
      origin: "https://git.example.test/acme/app.git",
      root: target,
      signal,
      staged: await stageCheckpointBundle({
        bundle: capture.bundle.path,
        gitCommit: capture.gitCommit,
        repository: join(keep, "checkpoint.git"),
        signal,
      }),
    });

    const repository = join(
      target,
      ".git",
      "agent-platform-checkpoint",
      "checkpoint.git",
    );
    expect(staged.repository).toBe(repository);
    await expect(
      git(repository, "cat-file", "-e", `${pinned}:CLAUDE.md`),
    ).resolves.toBe("");
    await expect(git(repository, "cat-file", "-e", later)).rejects.toThrow();
    const counted = await git(repository, "count-objects", "-v");
    const kib = (field: string) =>
      Number(new RegExp(`^${field}: (\\d+)$`, "m").exec(counted)?.[1]);
    expect((kib("size") + kib("size-pack")) * 1024).toBeLessThan(
      capture.bundle.bytes / 4,
    );
    expect(await git(target, "for-each-ref")).not.toContain("refs/restore/");

    // The engine rewrites history and prunes the commit it started from.
    await git(target, "checkout", "--quiet", "--orphan", "rewritten");
    await git(target, "commit", "--quiet", "-m", "rewritten");
    await git(target, "branch", "--quiet", "-D", "main");
    await git(target, "reflog", "expire", "--expire=now", "--all");
    await git(target, "gc", "--quiet", "--prune=now");
    await expect(git(target, "cat-file", "-e", pinned)).rejects.toThrow();
    const next = await captured(target, {
      commit: pinned,
      objects: join(staged.repository, "objects"),
    });
    const again = await stageCheckpointBundle({
      bundle: next.bundle.path,
      gitCommit: next.gitCommit,
      repository: join(scratch, "again.git"),
      signal,
    });
    expect(await stagedClaudeMd(again, signal)).toEqual({
      kind: "text",
      text: "rules\n",
    });
  }, 30_000);

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
    await git(
      repository,
      "fetch",
      "--quiet",
      capture.bundle.path,
      "refs/*:refs/*",
    );
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
    ).rejects.toThrow(
      new CheckpointBundleRefused(
        "Checkpoint bundle carries refs a capture does not write: refs/tags/extra",
      ),
    );
    expect(capture.gitCommit).toBe(
      (await git(repository, "rev-parse", CHECKPOINT_WORKTREE_REF)).trim(),
    );
  });
});

// Finalize and restore read a bundle's refs by one rule: what one refuses
// the other does, so no checkpoint commits that a resume cannot check out.
describe("a bundle finalize and restore both refuse (94S-391)", () => {
  test.each([
    ["without refs/checkpoint/worktree", ["refs/checkpoint/head"]],
    [
      "with two branches",
      [
        "refs/checkpoint/head",
        "refs/checkpoint/worktree",
        "refs/heads/a",
        "refs/heads/b",
      ],
    ],
    ["recorded against HEAD", ["HEAD"]],
  ])(
    "%s",
    async (_, refs) => {
      const odd = await createGitBundle({ refs });
      const path = join(scratch, "odd.bundle");
      await writeFile(path, odd.bytes);

      const verdict = await createGitWorkspaceBundleVerifier({
        tempRoot: scratch,
      }).verify({
        bytes: odd.bytes.byteLength,
        commit: odd.commit,
        key: "k",
        path,
      });
      const staged = stageCheckpointBundle({
        bundle: path,
        gitCommit: odd.commit,
        repository: join(scratch, "staged-odd.git"),
        signal: new AbortController().signal,
      });

      expect(verdict).toMatchObject({ status: "unusable" });
      if (verdict.status !== "unusable") throw new Error("unreachable");
      await expect(staged).rejects.toThrow(verdict.reason);
    },
    30_000,
  );
});

describe("a bundle built on the checkpoint before (94S-227)", () => {
  const onto = (...earlier: WorkspaceCapture[]): BundleBase => ({
    maxBytes: DEFAULT_WORKSPACE_CAPTURE_LIMITS.maxBundleBytes,
    tips: earlier.flatMap((capture) => capture.bundle.tips),
  });
  /** Stages `tip` after `bases`, oldest first, the way a restore does. */
  const staged = (tip: WorkspaceCapture, ...bases: WorkspaceCapture[]) =>
    stageCheckpointBundle({
      bases: bases.map((base) => base.bundle.path),
      bundle: tip.bundle.path,
      gitCommit: tip.gitCommit,
      repository: join(scratch, `staged-${crypto.randomUUID()}.git`),
      signal: new AbortController().signal,
    });
  /** The control plane's verdict, git-backed, on the chain as finalize sees it. */
  const verdict = (tip: WorkspaceCapture, ...bases: WorkspaceCapture[]) => {
    const file = (capture: WorkspaceCapture, key: string) => ({
      bytes: capture.bundle.bytes,
      key,
      path: capture.bundle.path,
    });
    return createGitWorkspaceBundleVerifier({ tempRoot: scratch }).verify({
      ...file(tip, "tip"),
      bases: bases.map((base, index) => file(base, `base-${index}`)),
      commit: tip.gitCommit,
    });
  };
  const restoredFrom = async (
    tip: WorkspaceCapture,
    ...bases: WorkspaceCapture[]
  ) => {
    const target = await staleRoot();
    await restoreCheckpointTree({
      origin: "https://git.example.test/acme/app.git",
      root: target,
      signal: new AbortController().signal,
      staged: await staged(tip, ...bases),
    });
    return target;
  };

  test("carries only what is new, and restores after its base", async () => {
    await commitFiles({
      "a.txt": "a\n",
      "random.txt": crypto.getRandomValues(new Uint8Array(64 * 1024)).join(),
    });
    const first = await captured();
    const head = await commitFiles({ "a.txt": "a, then b\n" });
    await writeFile(join(root, "a.txt"), "uncommitted\n");

    const second = await captured(root, undefined, onto(first));

    expect(first.bundle.incremental).toBe(false);
    expect(second.bundle.incremental).toBe(true);
    expect(await verdict(first)).toEqual({ status: "restorable" });
    expect(second.bundle.bytes).toBeLessThan(first.bundle.bytes / 10);
    await expect(staged(second)).rejects.toThrow();
    const target = await restoredFrom(second, first);
    expect(await readFile(join(target, "a.txt"), "utf8")).toBe("uncommitted\n");
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await git(target, "symbolic-ref", "HEAD")).toBe("refs/heads/main\n");
  });

  test("carries a capture that changed nothing as tags over the commits its base has", async () => {
    const head = await commitFiles({ "a.txt": "a\n" });
    const first = await captured();

    const second = await captured(root, undefined, onto(first));

    expect(second.bundle.incremental).toBe(true);
    expect(second.gitCommit).toBe(head);
    expect(await verdict(second, first)).toEqual({ status: "restorable" });
    const checkout = await staged(second, first);
    expect(checkout).toMatchObject({
      branch: "refs/heads/main",
      head,
      worktree: head,
    });
    const target = await restoredFrom(second, first);
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await git(target, "status", "--porcelain")).toBe("");
  });

  test("chains three deep, each link needing only tips of the ones before", async () => {
    await commitFiles({ "a.txt": "1\n" });
    const first = await captured();
    await commitFiles({ "a.txt": "2\n" });
    const second = await captured(root, undefined, onto(first));
    await writeFile(join(root, "a.txt"), "3, uncommitted\n");
    const third = await captured(root, undefined, onto(first, second));

    expect([second, third].map(({ bundle }) => bundle.incremental)).toEqual([
      true,
      true,
    ]);
    expect(await verdict(third, first, second)).toEqual({
      status: "restorable",
    });
    expect(await verdict(third, second)).toMatchObject({
      status: "unusable",
    });
    const target = await restoredFrom(third, first, second);
    expect(await readFile(join(target, "a.txt"), "utf8")).toBe(
      "3, uncommitted\n",
    );
  });

  test("chains three deep to a capture that changed nothing, which both finalize and restore take (94S-374)", async () => {
    await commitFiles({ "a.txt": "1\n" });
    const first = await captured();
    const head = await commitFiles({ "a.txt": "2\n" });
    const second = await captured(root, undefined, onto(first));
    const third = await captured(root, undefined, onto(first, second));

    expect(third.gitCommit).toBe(head);
    expect(await verdict(third, first, second)).toEqual({
      status: "restorable",
    });
    const target = await restoredFrom(third, first, second);
    expect((await git(target, "rev-parse", "HEAD")).trim()).toBe(head);
    expect(await git(target, "symbolic-ref", "HEAD")).toBe("refs/heads/main\n");
  }, 30_000);

  test("stands alone when history was rewritten under its base", async () => {
    await commitFiles({ "a.txt": "1\n" });
    await commitFiles({ "a.txt": "2\n" });
    const first = await captured();
    // Back past the base's tip, then on: the new commit's parent is in the
    // base's history, but no ref of the base offers it.
    await git(root, "reset", "--quiet", "--hard", "HEAD~1");
    await commitFiles({ "b.txt": "b\n" });

    const second = await captured(root, undefined, onto(first));

    expect(second.bundle.incremental).toBe(false);
    expect(
      readGitBundleHeader(await readFile(second.bundle.path)),
    ).toMatchObject({ prerequisites: [] });
    await staged(second);
  });

  test("stands alone when what it adds would take the chain over its byte limit", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const first = await captured();
    await commitFiles({
      "random.txt": crypto.getRandomValues(new Uint8Array(32 * 1024)).join(),
    });

    const second = await captured(root, undefined, {
      ...onto(first),
      maxBytes: 1024,
    });

    expect(second.bundle.incremental).toBe(false);
    await staged(second);
    // A chain already past a limit lowered since it was written.
    const third = await captured(root, undefined, {
      ...onto(first),
      maxBytes: -first.bundle.bytes,
    });
    expect(third.bundle.incremental).toBe(false);
  });
});
