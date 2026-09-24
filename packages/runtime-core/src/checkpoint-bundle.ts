/** The refs a checkpoint bundle carries; the restorer reads them back. */
export const CHECKPOINT_HEAD_REF = "refs/checkpoint/head";
export const CHECKPOINT_WORKTREE_REF = "refs/checkpoint/worktree";
/**
 * Where a bundle built on an earlier one carries HEAD's branch when the
 * earlier one already has its commit: under `refs/heads/` git keeps
 * commits only, and the branch then needs a tag (`refs/checkpoint/branch/
 * heads/main` for `refs/heads/main`).
 */
export const CHECKPOINT_BRANCH_PREFIX = "refs/checkpoint/branch/";
/**
 * The commit the session's repository CLAUDE.md is read from (94S-258): the
 * branch commit the first worker fetched, carried unchanged from checkpoint
 * to checkpoint so a resumed engine gets the instructions it started with.
 */
export const CHECKPOINT_INSTRUCTIONS_REF = "refs/checkpoint/instructions";

/**
 * `git for-each-ref --format` for `peeledCommits`: each ref with what it
 * points at and, for a tag, what the tag points at.
 */
export const PEELED_REF_FORMAT =
  "%(refname) %(objecttype) %(objectname) %(*objecttype) %(*objectname)";

/**
 * Reads `PEELED_REF_FORMAT` output: every ref with the commit it is, or the
 * commit the annotated tag it is points at directly (a capture that changed
 * nothing tags commits its base carries, 94S-374); null for anything else.
 */
export function peeledCommits(output: string): Map<string, string | null> {
  const commits = new Map<string, string | null>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const [name, type, oid, peeledType, peeled] = line.split(" ");
    if (name === undefined) continue;
    commits.set(
      name,
      type === "commit"
        ? (oid ?? null)
        : type === "tag" && peeledType === "commit"
          ? (peeled ?? null)
          : null,
    );
  }
  return commits;
}

/** What a restore checks out of a checkpoint bundle. */
export type CheckpointBundleRefs = {
  /** `refs/heads/<name>` HEAD was on, or null for a detached HEAD. */
  branch: string | null;
  head: string;
  instructions: string | null;
  worktree: string;
};

/**
 * The one rule for a checkpoint bundle's refs (94S-391): finalize applies it
 * before the pointer moves, and a restore before it touches the workspace,
 * so a checkpoint that commits is one a restore checks out. `refs` are the
 * refs the chain's last bundle lists, each with the commit it peels to
 * (`peeledCommits`), null when it peels to none. A bundle is what
 * `captureWorkspace` writes or it is refused: no ref it does not write, at
 * most one branch, HEAD's and the worktree's commits present, the worktree's
 * the manifest's `gitCommit`, and the branch at HEAD's commit.
 * `scripts/lib/backup-lib.sh` `unbundle_chain` checks the worktree part.
 */
export function checkpointBundleRefs(
  refs: ReadonlyArray<readonly [name: string, commit: string | null]>,
  gitCommit: string,
):
  | { status: "valid"; refs: CheckpointBundleRefs }
  | { status: "invalid"; reason: string } {
  const invalid = (reason: string) => ({ status: "invalid" as const, reason });
  const commits = new Map<string, string | null>();
  for (const [name, commit] of refs) {
    if (commits.has(name)) {
      return invalid(`Checkpoint bundle lists ${name} twice`);
    }
    commits.set(name, commit);
  }
  // As the bundle names them; one under `CHECKPOINT_BRANCH_PREFIX` stands
  // for the branch under `refs/heads/`.
  const branches = [...commits.keys()].filter(
    (name) =>
      name.startsWith("refs/heads/") ||
      name.startsWith(CHECKPOINT_BRANCH_PREFIX),
  );
  const unknown = [...commits.keys()].filter(
    (name) =>
      !branches.includes(name) &&
      name !== CHECKPOINT_HEAD_REF &&
      name !== CHECKPOINT_WORKTREE_REF &&
      name !== CHECKPOINT_INSTRUCTIONS_REF,
  );
  if (unknown.length > 0 || branches.length > 1) {
    return invalid(
      `Checkpoint bundle carries refs a capture does not write: ${[...unknown, ...branches.slice(1)].join(", ")}`,
    );
  }
  const notCommit = [...commits].find(([, commit]) => commit === null);
  if (notCommit !== undefined) {
    return invalid(`Checkpoint bundle's ${notCommit[0]} is not a commit`);
  }
  const head = commits.get(CHECKPOINT_HEAD_REF);
  const worktree = commits.get(CHECKPOINT_WORKTREE_REF);
  if (head == null || worktree == null) {
    return invalid(
      `Checkpoint bundle is missing ${CHECKPOINT_HEAD_REF} or ${CHECKPOINT_WORKTREE_REF}`,
    );
  }
  if (worktree !== gitCommit) {
    return invalid(
      `Checkpoint bundle pins worktree ${worktree}, not the manifest's ${gitCommit}`,
    );
  }
  const carried = branches[0];
  const branch =
    carried?.startsWith(CHECKPOINT_BRANCH_PREFIX) === true
      ? `refs/${carried.slice(CHECKPOINT_BRANCH_PREFIX.length)}`
      : (carried ?? null);
  if (carried !== undefined && commits.get(carried) !== head) {
    return invalid(`Checkpoint bundle's ${carried} is not at HEAD's commit`);
  }
  if (branch !== null && !branch.startsWith("refs/heads/")) {
    return invalid(`Checkpoint bundle carries ${carried}, which is no branch`);
  }
  return {
    status: "valid",
    refs: {
      branch,
      head,
      instructions: commits.get(CHECKPOINT_INSTRUCTIONS_REF) ?? null,
      worktree,
    },
  };
}
