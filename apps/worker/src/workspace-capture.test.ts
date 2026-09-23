import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitBundleHeader } from "@agent-platform/runtime-core";
import { GitOutputLimitError, runGitBytes } from "./workspace.ts";
import {
  CHECKPOINT_HEAD_REF,
  CHECKPOINT_WORKTREE_REF,
  captureWorkspace,
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
  type WorkspaceCapture,
} from "./workspace-capture.ts";

const procfs = existsSync("/proc/self/fd");

let scratch: string;
let root: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-246-capture-"));
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

async function capture(
  options: { limits?: Partial<typeof DEFAULT_WORKSPACE_CAPTURE_LIMITS> } = {},
) {
  return captureWorkspace({
    root,
    signal: new AbortController().signal,
    limits: { ...DEFAULT_WORKSPACE_CAPTURE_LIMITS, ...options.limits },
  });
}

async function captured(): Promise<WorkspaceCapture> {
  const result = await capture();
  if (result.status !== "captured") throw new Error(result.reason);
  return result.capture;
}

/** Everything a capture must leave exactly as it found it. */
async function fingerprint(): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(join(root, ".git", "index")));
  hash.update(await git(root, "rev-parse", "HEAD"));
  hash.update(await git(root, "for-each-ref"));
  hash.update(await git(root, "status", "--porcelain=v2", "--untracked=all"));
  hash.update(await git(root, "count-objects", "-v"));
  return hash.digest("hex");
}

/** Fetches the bundle into an empty repository, the way a restore does. */
async function unbundle(bundle: Uint8Array): Promise<string> {
  const target = join(scratch, `restored-${crypto.randomUUID()}`);
  await mkdir(target);
  await git(target, "init", "--quiet");
  const file = join(scratch, "fetched.bundle");
  await writeFile(file, bundle);
  await git(
    target,
    "fetch",
    "--quiet",
    file,
    `${CHECKPOINT_WORKTREE_REF}:${CHECKPOINT_WORKTREE_REF}`,
  );
  await git(target, "checkout", "--quiet", "--detach", CHECKPOINT_WORKTREE_REF);
  return target;
}

describe("captureWorkspace", () => {
  test("pins HEAD itself when the working tree matches it, and bundles the branch", async () => {
    const head = await commitFiles({ "a.txt": "a\n", "src/b.txt": "b\n" });
    const before = await fingerprint();

    const result = await captured();

    expect(result.gitCommit).toBe(head);
    expect(result.untracked).toEqual([]);
    const header = readGitBundleHeader(result.bundle);
    expect(header?.prerequisites).toEqual([]);
    expect(header?.refs).toEqual([
      { name: CHECKPOINT_HEAD_REF, oid: head },
      { name: CHECKPOINT_WORKTREE_REF, oid: head },
      { name: "refs/heads/main", oid: head },
    ]);
    expect(await fingerprint()).toBe(before);
  });

  test("commits uncommitted tracked edits on top of HEAD without touching the workspace", async () => {
    const head = await commitFiles({
      "a.txt": "a\n",
      "gone.txt": "g\n",
      "src/b.txt": "b\n",
    });
    await writeFile(join(root, "a.txt"), "a edited\n");
    await rm(join(root, "gone.txt"));
    await writeFile(join(root, "staged.txt"), "staged\n");
    await git(root, "add", "staged.txt");
    const before = await fingerprint();

    const result = await captured();

    expect(result.gitCommit).not.toBe(head);
    expect(await fingerprint()).toBe(before);
    const header = readGitBundleHeader(result.bundle);
    expect(header?.refs).toContainEqual({
      name: CHECKPOINT_HEAD_REF,
      oid: head,
    });
    expect(header?.refs).toContainEqual({
      name: CHECKPOINT_WORKTREE_REF,
      oid: result.gitCommit,
    });

    const restored = await unbundle(result.bundle);
    expect(await readFile(join(restored, "a.txt"), "utf8")).toBe("a edited\n");
    expect(await readFile(join(restored, "staged.txt"), "utf8")).toBe(
      "staged\n",
    );
    expect(existsSync(join(restored, "gone.txt"))).toBe(false);
    expect(
      (await git(restored, "rev-parse", `${CHECKPOINT_WORKTREE_REF}^`)).trim(),
    ).toBe(head);
  });

  test("stages a chmod even in a checkout told to ignore modes", async () => {
    await commitFiles({ "run.sh": "#!/bin/sh\n" });
    await git(root, "config", "core.fileMode", "false");
    await chmod(join(root, "run.sh"), 0o755);

    const result = await captured();

    const restored = await unbundle(result.bundle);
    expect(await git(restored, "ls-tree", "HEAD", "run.sh")).toStartWith(
      "100755 ",
    );
  });

  test("bundles no branch for a detached HEAD", async () => {
    const head = await commitFiles({ "a.txt": "a\n" });
    await git(root, "checkout", "--quiet", "--detach");

    const header = readGitBundleHeader((await captured()).bundle);

    expect(header?.refs.map((ref) => ref.name)).toEqual([
      CHECKPOINT_HEAD_REF,
      CHECKPOINT_WORKTREE_REF,
    ]);
    expect(header?.refs[0]?.oid).toBe(head);
  });

  test("never writes an object into the workspace repository", async () => {
    await commitFiles({ "a.txt": "a\n" });
    await writeFile(join(root, "a.txt"), "only on disk\n");
    const objects = async () =>
      (
        await readdir(join(root, ".git", "objects"), { recursive: true })
      ).sort();
    const before = await objects();

    await captured();

    expect(await objects()).toEqual(before);
  });

  describe("refuses a workspace it cannot represent exactly", () => {
    test("an unborn HEAD", async () => {
      expect(await capture()).toEqual({
        status: "refused",
        reason: "HEAD has no commit yet",
      });
    });

    test("a .git that is not a directory", async () => {
      await rm(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git"), "gitdir: /elsewhere\n");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace .git is not a directory",
      });
    });

    test("a shallow clone", async () => {
      await commitFiles({ "a.txt": "1\n" });
      await commitFiles({ "a.txt": "2\n" });
      const shallow = join(scratch, "shallow");
      await git(
        scratch,
        "clone",
        "--quiet",
        "--depth=1",
        `file://${root}`,
        shallow,
      );
      root = shallow;
      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace is a shallow clone",
      });
    });

    test("sparse checkout", async () => {
      await commitFiles({ "a.txt": "a\n", "src/b.txt": "b\n" });
      await git(root, "sparse-checkout", "set", "src");
      expect(await capture()).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/sparse checkout|skip-worktree/),
      });
    });

    test("a split index", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await git(root, "update-index", "--split-index");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "the workspace uses a split index",
      });
    });

    test("an entry marked assume-unchanged", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await git(root, "update-index", "--assume-unchanged", "a.txt");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "a.txt is marked assume-unchanged",
      });
    });

    test("an entry marked skip-worktree", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await git(root, "update-index", "--skip-worktree", "a.txt");
      expect(await capture()).toEqual({
        status: "refused",
        reason: "a.txt is marked skip-worktree",
      });
    });

    test("a tracked submodule", async () => {
      await commitFiles({ "a.txt": "a\n" });
      const head = (await git(root, "rev-parse", "HEAD")).trim();
      await git(
        root,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},vendor/lib`,
      );
      expect(await capture()).toEqual({
        status: "refused",
        reason: "vendor/lib is a submodule",
      });
    });

    test("unresolved merge conflicts", async () => {
      await commitFiles({ "a.txt": "base\n" });
      await git(root, "checkout", "--quiet", "-b", "other");
      await commitFiles({ "a.txt": "other\n" });
      await git(root, "checkout", "--quiet", "main");
      await commitFiles({ "a.txt": "main\n" });
      await git(root, "merge", "--quiet", "other").catch(() => undefined);
      expect(await capture()).toEqual({
        status: "refused",
        reason: "a.txt has unresolved merge conflicts",
      });
    });

    test("an end-of-line conversion that would not come back byte for byte", async () => {
      await commitFiles({ ".gitattributes": "*.txt text eol=crlf\n" });
      await writeFile(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
      await commitFiles({ "a.txt": "one\r\n" });
      await writeFile(join(root, "a.txt"), "one\r\ntwo\n");
      expect(await capture()).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/cannot be staged/),
      });
    });

    test("an untracked nested repository", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await mkdir(join(root, "vendor/lib"), { recursive: true });
      await git(join(root, "vendor/lib"), "init", "--quiet");
      await writeFile(join(root, "vendor/lib/x"), "x\n");
      await git(join(root, "vendor/lib"), "add", "x");
      await git(join(root, "vendor/lib"), "commit", "--quiet", "-m", "x");
      expect(await capture()).toEqual({
        status: "refused",
        reason:
          "untracked vendor/lib/ is a nested repository, which a checkpoint cannot carry",
      });
    });

    test("more untracked files than a checkpoint carries", async () => {
      await commitFiles({ "a.txt": "a\n" });
      for (const name of ["x", "y", "z"]) {
        await writeFile(join(root, name), name);
      }
      expect(await capture({ limits: { maxUntrackedFiles: 2 } })).toEqual({
        status: "refused",
        reason: "3 untracked files, over the 2 a checkpoint carries",
      });
    });

    test("a bundle over the control plane's limit", async () => {
      await commitFiles({ "a.txt": "a\n" });
      expect(await capture({ limits: { maxBundleBytes: 10 } })).toMatchObject({
        status: "refused",
        reason:
          "the workspace bundle is over the 10 bytes the control plane verifies",
      });
    });

    // Linux keeps a name's bytes as they are; macOS refuses a name that is
    // not UTF-8 before git ever sees it.
    test.skipIf(process.platform !== "linux")(
      "an untracked name that is not UTF-8, even beside the ignored file a lossy decode would name",
      async () => {
        await commitFiles({ ".gitignore": "bad\ufffd\n", "a.txt": "a\n" });
        const raw = Buffer.concat([
          Buffer.from(join(root, "bad")),
          Buffer.from([0xff]),
        ]);
        await writeFile(raw, "untracked\n");
        await writeFile(join(root, "bad\ufffd"), "ignored secret\n");

        expect(await capture()).toEqual({
          status: "refused",
          reason: "an untracked file's name is not valid UTF-8",
        });
      },
    );

    test("an index over the limit, before any git command reads it", async () => {
      await commitFiles({ "a.txt": "a\n" });

      expect(await capture({ limits: { maxIndexBytes: 10 } })).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(
          /^the workspace index is \d+ bytes, over the 10 a checkpoint reads$/,
        ),
      });
    });

    test("tracked changes over the staging limit, before they are written as objects", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "a.txt"), "x".repeat(100));

      expect(await capture({ limits: { maxStagedBytes: 50 } })).toEqual({
        status: "refused",
        reason: "the tracked changes are over the 50 bytes a checkpoint stages",
      });
      // An unchanged checkout stages nothing, whatever the limit.
      await writeFile(join(root, "a.txt"), "a\n");
      expect((await capture({ limits: { maxStagedBytes: 0 } })).status).toBe(
        "captured",
      );
    });

    test("an untracked file it cannot read without following paths", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "notes.md"), "n\n");
      const result = await captureWorkspace({
        root,
        signal: new AbortController().signal,
        fdDirectory: join(scratch, "no-procfs"),
      });
      expect(result).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/cannot be read safely/),
      });
    });
  });

  // Untracked files are read by descriptor, which needs procfs.
  describe.skipIf(!procfs)("untracked files", () => {
    test("captures untracked files but not ignored ones", async () => {
      await commitFiles({ ".gitignore": "build/\n", "a.txt": "a\n" });
      await mkdir(join(root, "notes"), { recursive: true });
      await writeFile(join(root, "notes/todo.md"), "todo\n");
      await writeFile(join(root, "z.txt"), "z\n");
      await mkdir(join(root, "build"));
      await writeFile(join(root, "build/out.js"), "ignored\n");

      const result = await captured();

      expect(
        result.untracked.map(({ bytes, path }) => [
          path,
          new TextDecoder().decode(bytes),
        ]),
      ).toEqual([
        ["notes/todo.md", "todo\n"],
        ["z.txt", "z\n"],
      ]);
    });

    test("keeps a leading U+FEFF in a name instead of reading the ignored file it would alias", async () => {
      await commitFiles({ ".gitignore": "secrets.txt\n", "a.txt": "a\n" });
      await writeFile(join(root, "secrets.txt"), "ignored secret\n");
      await writeFile(join(root, "\ufeffsecrets.txt"), "untracked\n");

      const result = await captured();

      expect(
        result.untracked.map(({ bytes, path }) => [
          path,
          new TextDecoder().decode(bytes),
        ]),
      ).toEqual([["\ufeffsecrets.txt", "untracked\n"]]);
    });

    test("keeps whether an untracked file is executable", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "tool"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(root, "data"), "x\n", { mode: 0o644 });

      const result = await captured();

      expect(
        result.untracked.map(({ executable, path }) => [path, executable]),
      ).toEqual([
        ["data", false],
        ["tool", true],
      ]);
    });

    test("refuses an untracked symlink rather than reading what it points at", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(scratch, "worker-secret"), "secret\n");
      await symlink(join(scratch, "worker-secret"), join(root, "planted"));

      expect(await capture()).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/"planted" is not a regular file/),
      });
    });

    test("refuses untracked files over the byte budget", async () => {
      await commitFiles({ "a.txt": "a\n" });
      await writeFile(join(root, "x"), "12345");
      await writeFile(join(root, "y"), "12345");

      expect(await capture({ limits: { maxUntrackedBytes: 8 } })).toEqual({
        status: "refused",
        reason: 'untracked file "y" is 5 bytes, over the 3 left',
      });
    });
  });
});

describe("runGitBytes", () => {
  test("kills git once it writes past the limit instead of buffering it all", async () => {
    await commitFiles({ "big.bin": "x".repeat(4 * 1024 * 1024) });
    const blob = (await git(root, "rev-parse", "HEAD:big.bin")).trim();

    const reading = runGitBytes(["cat-file", "blob", blob], {
      cwd: root,
      maxStdoutBytes: 64 * 1024,
      network: null,
      overrides: [],
      redact: (text) => text,
      signal: new AbortController().signal,
    });

    await expect(reading).rejects.toBeInstanceOf(GitOutputLimitError);
  });

  test("hands back the exact bytes git wrote under the limit", async () => {
    await commitFiles({ "a.txt": "a\n" });
    const blob = (await git(root, "rev-parse", "HEAD:a.txt")).trim();

    const result = await runGitBytes(["cat-file", "blob", blob], {
      cwd: root,
      maxStdoutBytes: 2,
      network: null,
      overrides: [],
      redact: (text) => text,
      signal: new AbortController().signal,
    });

    expect(result.code).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("a\n");
  });
});
