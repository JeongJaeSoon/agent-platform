import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile } from "@agent-platform/runtime-core";

import {
  check,
  filterOverrides,
  type Git,
  type GitExtras,
  type GitResult,
  runGit,
} from "./workspace.ts";

/**
 * What one checkpoint pins of the workspace: a bundle that can recreate the
 * commit on its own, and the untracked files git does not carry.
 */
export type WorkspaceCapture = {
  bundle: Uint8Array;
  /** The snapshot commit, `refs/checkpoint/worktree` in the bundle. */
  gitCommit: string;
  untracked: Array<{ bytes: Uint8Array; path: string }>;
};

export type WorkspaceCaptureResult =
  | { capture: WorkspaceCapture; status: "captured" }
  | { reason: string; status: "refused" };

export type WorkspaceCaptureLimits = {
  /** The control plane refuses a larger bundle (`DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES`). */
  maxBundleBytes: number;
  maxUntrackedBytes: number;
  maxUntrackedFiles: number;
};

/**
 * Deliberately minimal: the whole history rides every checkpoint and the
 * untracked files are held in memory to be uploaded. Revisit when sessions
 * approach these (94S-227 makes bundles incremental).
 */
export const DEFAULT_WORKSPACE_CAPTURE_LIMITS: WorkspaceCaptureLimits = {
  maxBundleBytes: 128 * 1024 * 1024,
  maxUntrackedBytes: 256 * 1024 * 1024,
  maxUntrackedFiles: 10_000,
};

/** The refs a checkpoint bundle carries; the restorer reads them back. */
export const CHECKPOINT_HEAD_REF = "refs/checkpoint/head";
export const CHECKPOINT_WORKTREE_REF = "refs/checkpoint/worktree";

// Neither side of a checkpoint may depend on the repository's own EOL
// settings: the restore runs in a fresh repository that has none. With
// autocrlf off only `.gitattributes` converts, and it travels in the tree;
// safecrlf refuses a conversion that would not come back byte for byte.
const CAPTURE_CONFIG: Array<[string, string]> = [
  ["core.autocrlf", "false"],
  ["core.safecrlf", "true"],
];

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_EMAIL: "checkpoint@agent-platform.invalid",
  GIT_AUTHOR_NAME: "agent-platform checkpoint",
  GIT_COMMITTER_EMAIL: "checkpoint@agent-platform.invalid",
  GIT_COMMITTER_NAME: "agent-platform checkpoint",
};

/**
 * Captures the workspace at `root` without changing anything in it.
 *
 * The engine's HEAD, index and object store are left as they are. The
 * working tree is staged into a copy of the index, and every object that
 * produces — blobs, the tree, the snapshot commit — is written to a scratch
 * repository that reads the workspace's objects through an alternate. The
 * bundle is built there too, under refs that exist nowhere else:
 *
 * - `refs/checkpoint/head`: the commit HEAD is on;
 * - `refs/checkpoint/worktree`: the tree as it is on disk, committed on top
 *   of HEAD when it differs and HEAD itself when it does not. This is the
 *   manifest's `gitCommit`.
 * - `refs/heads/<branch>`: HEAD's branch, when HEAD is on one.
 *
 * so a restore can put the same branch at the same commit and leave the
 * uncommitted edits uncommitted, rather than handing the engine a history
 * with a commit it never made.
 *
 * A workspace whose state this cannot represent exactly is refused, never
 * approximated: an unborn HEAD, a shallow or partial clone, sparse checkout,
 * a split index, unmerged paths, entries marked assume-unchanged or
 * skip-worktree (their disk content is not what `add -u` stages), tracked
 * submodules, untracked symlinks or special files, and untracked nested
 * repositories. Ignored files are not captured at all — build output and
 * dependencies, but also an ignored `.env`; a resumed session starts without
 * them.
 */
export async function captureWorkspace(input: {
  root: string;
  signal: AbortSignal;
  limits?: WorkspaceCaptureLimits;
  /** For tests that need procfs to be missing. */
  fdDirectory?: string;
}): Promise<WorkspaceCaptureResult> {
  const { root, signal } = input;
  const limits = input.limits ?? DEFAULT_WORKSPACE_CAPTURE_LIMITS;
  const refused = (reason: string): WorkspaceCaptureResult => ({
    status: "refused",
    reason,
  });
  const gitDirectory = join(root, ".git");
  const found = await lstat(gitDirectory).catch(() => null);
  if (found?.isDirectory() !== true) {
    return refused("the workspace .git is not a directory");
  }
  const scratch = await mkdtemp(join(tmpdir(), "worker-capture-"));
  try {
    const repository = join(scratch, "checkpoint.git");
    const neutralized: Array<[string, string]> = [];
    const run = (args: string[], env: Record<string, string>) =>
      runGit(args, {
        cwd: root,
        extra: { config: CAPTURE_CONFIG, env },
        network: null,
        overrides: neutralized,
        redact: (text) => text,
        signal,
      });
    const workspace: Git = (args) =>
      run(args, { GIT_DIR: gitDirectory, GIT_WORK_TREE: root });
    neutralized.push(...(await filterOverrides(workspace)));

    const head = await workspace([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
    if (head.code !== 0) return refused("HEAD has no commit yet");
    const headCommit = head.stdout.trim();
    const problem = await unrepresentable(workspace, gitDirectory);
    if (problem !== undefined) return refused(problem);

    const index = join(scratch, "index");
    const copied = await copyIndex(gitDirectory, index);
    if (copied !== undefined) return refused(copied);
    await check(
      run(["init", "--quiet", "--bare", repository], {}),
      "init scratch",
    );
    await writeFile(
      join(repository, "objects", "info", "alternates"),
      `${join(gitDirectory, "objects")}\n`,
    );
    // Stages into the copy and writes objects into the scratch repository;
    // the workspace's own index and object store are only read.
    const staging: GitExtras["env"] = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDirectory, "objects"),
      GIT_DIR: gitDirectory,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: join(repository, "objects"),
      GIT_WORK_TREE: root,
    };
    const stage = (args: string[], env: Record<string, string> = {}) =>
      run(args, { ...staging, ...env });
    const added = await stage(["add", "--update", "--", "."]);
    if (added.code !== 0) {
      return refused(`the working tree cannot be staged: ${lastLine(added)}`);
    }
    const tree = (await required(stage(["write-tree"]), "write-tree")).trim();
    const headTree = (
      await required(
        workspace(["rev-parse", `${headCommit}^{tree}`]),
        "rev-parse",
      )
    ).trim();
    const gitCommit =
      tree === headTree
        ? headCommit
        : (
            await required(
              stage(
                [
                  "commit-tree",
                  tree,
                  "-p",
                  headCommit,
                  "-m",
                  "agent-platform checkpoint: working tree",
                ],
                SNAPSHOT_IDENTITY,
              ),
              "commit-tree",
            )
          ).trim();

    const others = await required(
      stage(["ls-files", "-z", "--others", "--exclude-standard"]),
      "ls-files",
    );
    const paths = others.split("\0").filter((path) => path !== "");
    const nested = paths.find((path) => path.endsWith("/"));
    if (nested !== undefined) {
      return refused(
        `untracked ${nested} is a nested repository, which a checkpoint cannot carry`,
      );
    }
    if (paths.length > limits.maxUntrackedFiles) {
      return refused(
        `${paths.length} untracked files, over the ${limits.maxUntrackedFiles} a checkpoint carries`,
      );
    }

    const branch = await workspace(["symbolic-ref", "--quiet", "HEAD"]);
    const refs: Array<[string, string]> = [
      [CHECKPOINT_HEAD_REF, headCommit],
      [CHECKPOINT_WORKTREE_REF, gitCommit],
    ];
    if (branch.code === 0) {
      const name = branch.stdout.trim();
      const valid = await workspace(["check-ref-format", name]);
      if (!name.startsWith("refs/heads/") || valid.code !== 0) {
        return refused(`HEAD is on a ref git would not restore: ${name}`);
      }
      refs.push([name, headCommit]);
    }
    const bundling = (args: string[]) => run(args, { GIT_DIR: repository });
    for (const [name, oid] of refs) {
      await check(bundling(["update-ref", name, oid]), "update-ref");
    }
    const bundlePath = join(scratch, "workspace.bundle");
    await check(
      bundling([
        "bundle",
        "create",
        "--quiet",
        bundlePath,
        ...refs.map(([name]) => name),
      ]),
      "bundle create",
    );
    const size = (await stat(bundlePath)).size;
    if (size > limits.maxBundleBytes) {
      return refused(
        `the workspace bundle is ${size} bytes, over the ${limits.maxBundleBytes} the control plane verifies`,
      );
    }
    const bundle = new Uint8Array(await readFile(bundlePath));

    const untracked: WorkspaceCapture["untracked"] = [];
    let left = limits.maxUntrackedBytes;
    for (const path of paths.sort()) {
      const read = await readWorkspaceFile({
        maxBytes: left,
        path,
        workspaceRoot: root,
        ...(input.fdDirectory === undefined
          ? {}
          : { fdDirectory: input.fdDirectory }),
      });
      if (read.status === "refused") return refused(read.reason);
      left -= read.bytes.byteLength;
      untracked.push({ bytes: read.bytes, path });
    }
    return { status: "captured", capture: { bundle, gitCommit, untracked } };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

/** Why `add -u` against this repository would not stage what is on disk. */
async function unrepresentable(
  git: Git,
  gitDirectory: string,
): Promise<string | undefined> {
  const shallow = await git(["rev-parse", "--is-shallow-repository"]);
  if (shallow.code !== 0 || shallow.stdout.trim() !== "false") {
    return "the workspace is a shallow clone";
  }
  const flags: Array<[string, string]> = [
    ["core.sparseCheckout", "uses sparse checkout"],
    ["core.splitIndex", "uses a split index"],
  ];
  for (const [key, what] of flags) {
    const value = await git(["config", "--bool", "--get", key]);
    if (value.code === 0 && value.stdout.trim() === "true") {
      return `the workspace ${what}`;
    }
  }
  const partial = await git([
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
  ]);
  if (partial.code === 0 && partial.stdout.trim() !== "") {
    return "the workspace is a partial clone";
  }
  const shared = (await readdir(gitDirectory)).find((name) =>
    name.startsWith("sharedindex."),
  );
  if (shared !== undefined) return "the workspace uses a split index";
  const staged = await required(git(["ls-files", "-z", "--stage"]), "ls-files");
  for (const entry of staged.split("\0")) {
    if (entry === "") continue;
    const [meta = "", path = ""] = entry.split("\t");
    const [mode, , stageNumber] = meta.split(" ");
    if (stageNumber !== "0") return `${path} has unresolved merge conflicts`;
    if (mode === "160000") return `${path} is a submodule`;
  }
  const tagged = await required(git(["ls-files", "-z", "-v"]), "ls-files");
  for (const entry of tagged.split("\0")) {
    if (entry === "") continue;
    const tag = entry.slice(0, 1);
    const path = entry.slice(2);
    if (tag === "S") return `${path} is marked skip-worktree`;
    if (tag !== tag.toUpperCase()) return `${path} is marked assume-unchanged`;
  }
  return undefined;
}

/**
 * Copies the workspace index without following a symlink planted in its
 * place; the copy is what gets staged into. A missing index is an empty one.
 */
async function copyIndex(
  gitDirectory: string,
  destination: string,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      join(gitDirectory, "index"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") return "the workspace index is a symlink";
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      return "the workspace index is not a regular file";
    }
    await writeFile(destination, await handle.readFile());
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function required(
  result: Promise<GitResult>,
  step: string,
): Promise<string> {
  const { code, stderr, stdout } = await result;
  if (code !== 0) {
    throw new Error(`git ${step} failed (exit ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

function lastLine(result: GitResult): string {
  return result.stderr.trim().split("\n").at(-1) ?? `exit ${result.code}`;
}
