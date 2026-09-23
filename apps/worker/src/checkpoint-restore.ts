import { lstat, opendir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CommittedClaudeMd,
  check,
  type Git,
  readCommittedClaudeMd,
  runGit,
} from "./workspace.ts";
import {
  CHECKPOINT_GIT_CONFIG,
  CHECKPOINT_HEAD_REF,
  CHECKPOINT_INSTRUCTIONS_REF,
  CHECKPOINT_WORKTREE_REF,
  checkpointGitLimits,
  required,
} from "./workspace-capture.ts";

/**
 * A checkpoint bundle fetched into a repository of the worker's own, outside
 * the workspace, and checked against the manifest before the workspace is
 * touched. The repository outlives the restore: the instructions commit is
 * read from it, and later captures keep it as an object source so that
 * commit stays bundleable after the engine prunes its own copy.
 */
export type StagedCheckpoint = {
  /** `refs/heads/<name>` HEAD was on, or null for a detached HEAD. */
  branch: string | null;
  head: string;
  instructions: string | null;
  repository: string;
  worktree: string;
};

const STAGED = "refs/bundle/";
const RESTORING = "refs/restore/";
/** Names read from the old root before any of them is removed. */
const CLEAR_BATCH = 1024;

/**
 * Fetches `bundle` into a new bare repository at `repository` and reads its
 * refs back. Throws for a bundle that is not the one `captureWorkspace`
 * writes: a ref it does not write, a required ref missing, a branch that
 * is not at HEAD's commit, or a worktree commit other than the manifest's.
 * The fetch checks every object (`fsckObjects`), so what is staged is whole.
 */
export async function stageCheckpointBundle(input: {
  bundle: string;
  gitCommit: string;
  repository: string;
  signal: AbortSignal;
}): Promise<StagedCheckpoint> {
  const { repository, signal } = input;
  const git = localGit(dirname(repository), signal, { GIT_DIR: repository });
  await check(
    git(["init", "--quiet", "--bare", "--template=", repository]),
    "init",
  );
  const heads = await required(
    git(["bundle", "list-heads", input.bundle]),
    "bundle list-heads",
  );
  const refs = new Map<string, string>();
  for (const line of heads.split("\n")) {
    if (line === "") continue;
    const [oid, name] = line.split(" ");
    if (oid === undefined || name === undefined || refs.has(name)) {
      throw new Error(`Checkpoint bundle lists a malformed ref: ${line}`);
    }
    refs.set(name, oid);
  }
  const branches = [...refs.keys()].filter((name) =>
    name.startsWith("refs/heads/"),
  );
  const unknown = [...refs.keys()].filter(
    (name) =>
      !name.startsWith("refs/heads/") &&
      name !== CHECKPOINT_HEAD_REF &&
      name !== CHECKPOINT_WORKTREE_REF &&
      name !== CHECKPOINT_INSTRUCTIONS_REF,
  );
  if (unknown.length > 0 || branches.length > 1) {
    throw new Error(
      `Checkpoint bundle carries refs a capture does not write: ${[...unknown, ...branches.slice(1)].join(", ")}`,
    );
  }
  await check(
    git([
      "-c",
      "fetch.fsckObjects=true",
      "-c",
      "transfer.fsckObjects=true",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      input.bundle,
      `refs/*:${STAGED}*`,
    ]),
    "fetch bundle",
  );
  const commit = async (name: string): Promise<string | null> => {
    if (!refs.has(name)) return null;
    const staged = `${STAGED}${name.slice("refs/".length)}`;
    return (
      await required(
        git(["rev-parse", "--verify", "--quiet", `${staged}^{commit}`]),
        `rev-parse ${name}`,
      )
    ).trim();
  };
  const head = await commit(CHECKPOINT_HEAD_REF);
  const worktree = await commit(CHECKPOINT_WORKTREE_REF);
  if (head === null || worktree === null) {
    throw new Error(
      `Checkpoint bundle is missing ${CHECKPOINT_HEAD_REF} or ${CHECKPOINT_WORKTREE_REF}`,
    );
  }
  if (worktree !== input.gitCommit) {
    throw new Error(
      `Checkpoint bundle pins worktree ${worktree}, not the manifest's ${input.gitCommit}`,
    );
  }
  const branch = branches[0] ?? null;
  if (branch !== null && (await commit(branch)) !== head) {
    throw new Error(`Checkpoint bundle's ${branch} is not at HEAD's commit`);
  }
  return {
    branch,
    head,
    instructions: await commit(CHECKPOINT_INSTRUCTIONS_REF),
    repository,
    worktree,
  };
}

/**
 * CLAUDE.md as committed at the staged instructions commit. A checkpoint
 * that pins none is refused rather than read as having no CLAUDE.md, so a
 * profile that wants the file fails instead of resuming without it.
 */
export async function stagedClaudeMd(
  staged: StagedCheckpoint,
  signal: AbortSignal,
): Promise<CommittedClaudeMd> {
  if (staged.instructions === null) {
    return {
      kind: "refused",
      reason: "the checkpoint pins no commit it can be read at",
    };
  }
  return readCommittedClaudeMd(
    localGit(staged.repository, signal, { GIT_DIR: staged.repository }),
    staged.repository,
    staged.instructions,
    signal,
  );
}

/**
 * Replaces everything under `root` with the staged checkout: the branch (or
 * detached HEAD) at HEAD's commit, the working tree as it was on disk, and
 * the index at HEAD, so edits that were uncommitted are uncommitted again.
 * Files the snapshot added are left intent-to-add rather than untracked, so
 * the next capture stages them again even when they are ignored.
 *
 * The root is the mount point and stays; its contents go, so nothing a
 * previous execution wrote after the checkpoint survives. The repository is
 * new: the old one's config, hooks and remotes are the last engine's.
 * Stops between steps once `signal` aborts; a restore stopped half way is
 * redone whole by the next attempt, which never reads what this one left.
 */
export async function restoreCheckpointTree(input: {
  origin: string;
  root: string;
  signal: AbortSignal;
  staged: StagedCheckpoint;
}): Promise<void> {
  const { root, signal, staged } = input;
  // Everything below deletes through `root`: a link there would aim it
  // somewhere else.
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(`the workspace root ${root} is not a directory`);
  }
  // In batches, so an execution that left millions of names behind is not
  // read into memory at once. Each pass starts over, since what a directory
  // stream returns after its own entries are removed is unspecified.
  for (;;) {
    const batch: string[] = [];
    for await (const entry of await opendir(root)) {
      batch.push(entry.name);
      if (batch.length === CLEAR_BATCH) break;
    }
    if (batch.length === 0) break;
    for (const name of batch) {
      signal.throwIfAborted();
      await rm(join(root, name), { force: true, recursive: true });
    }
  }
  const git = localGit(root, signal, {});
  await check(git(["init", "--quiet", "--template="]), "init");
  await check(
    git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      staged.repository,
      `${STAGED}*:${RESTORING}*`,
    ]),
    "fetch staged checkpoint",
  );
  if (staged.branch === null) {
    await check(
      git(["update-ref", "--no-deref", "HEAD", staged.head]),
      "update-ref",
    );
  } else {
    await check(git(["update-ref", staged.branch, staged.head]), "update-ref");
    await check(git(["symbolic-ref", "HEAD", staged.branch]), "symbolic-ref");
  }
  await check(
    git(["read-tree", "--reset", "-u", staged.worktree]),
    "read-tree",
  );
  await check(
    git(["reset", "--quiet", "--mixed", "--intent-to-add", staged.head]),
    "reset",
  );
  const restoring = await required(
    git(["for-each-ref", "--format=%(refname)", RESTORING]),
    "for-each-ref",
  );
  for (const name of restoring.split("\n")) {
    if (name !== "") await check(git(["update-ref", "-d", name]), "update-ref");
  }
  await check(git(["remote", "add", "origin", input.origin]), "remote add");
}

/**
 * A git that never reaches the network, with the capture's settings and
 * limits: one that runs out throws `GitResourceLimitError`, which fails the
 * restore like any other git failure.
 */
function localGit(
  cwd: string,
  signal: AbortSignal,
  env: Record<string, string>,
): Git {
  return (args, options = {}) =>
    runGit(args, {
      cwd: options.cwd ?? cwd,
      extra: { config: CHECKPOINT_GIT_CONFIG, env },
      limits: checkpointGitLimits(),
      network: null,
      overrides: [],
      redact: (text) => text,
      signal,
    });
}
