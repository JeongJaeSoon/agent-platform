import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GitResourceLimits,
  readWorkspaceFile,
} from "@agent-platform/runtime-core";

import {
  check,
  filterOverrides,
  type Git,
  type GitExtras,
  GitOutputLimitError,
  GitResourceLimitError,
  type GitResult,
  LOCAL_DEADLINE_MS,
  runGitBytes,
} from "./workspace.ts";

/**
 * What one checkpoint pins of the workspace: a bundle that can recreate the
 * commit on its own, and the untracked files git does not carry.
 */
export type WorkspaceCapture = {
  bundle: Uint8Array;
  /** The snapshot commit, `refs/checkpoint/worktree` in the bundle. */
  gitCommit: string;
  untracked: Array<{ bytes: Uint8Array; executable: boolean; path: string }>;
};

export type WorkspaceCaptureResult =
  | { capture: WorkspaceCapture; status: "captured" }
  | { reason: string; status: "refused" };

export type WorkspaceCaptureLimits = {
  /**
   * At most the control plane's `DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES`, which
   * refuses anything larger. Lower than it because the worker still holds
   * the bundle in memory to upload it; the control plane streams it.
   */
  maxBundleBytes: number;
  /**
   * Any one tracked file on disk. A restore writes each one back under a file
   * size limit (`checkpointGitLimits`), so a capture refuses what that would
   * refuse rather than pin a checkpoint no worker can resume from.
   */
  maxFileBytes: number;
  /** The workspace index is copied whole before anything reads it. */
  maxIndexBytes: number;
  /**
   * Tracked files that differ from the index, summed before `add -u` writes
   * them into the scratch object store: the bundle limit is only known once
   * that disk is spent.
   */
  maxStagedBytes: number;
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
  maxFileBytes: 512 * 1024 * 1024,
  maxIndexBytes: 256 * 1024 * 1024,
  maxStagedBytes: 512 * 1024 * 1024,
  maxUntrackedBytes: 256 * 1024 * 1024,
  maxUntrackedFiles: 10_000,
};

/** The refs a checkpoint bundle carries; the restorer reads them back. */
export const CHECKPOINT_HEAD_REF = "refs/checkpoint/head";
export const CHECKPOINT_WORKTREE_REF = "refs/checkpoint/worktree";
/**
 * The commit the session's repository CLAUDE.md is read from (94S-258): the
 * branch commit the first worker fetched, carried unchanged from checkpoint
 * to checkpoint so a resumed engine gets the instructions it started with.
 */
export const CHECKPOINT_INSTRUCTIONS_REF = "refs/checkpoint/instructions";

/**
 * The instructions commit a capture pins, and where its objects are kept
 * when the workspace may no longer have them (a restore keeps them in a
 * repository of its own, outside the engine's reach).
 */
export type InstructionsPin = { commit: string; objects?: string };

// Neither side of a checkpoint may depend on the repository's own config:
// the restore runs in a fresh repository that has none, on Linux. With
// autocrlf off and eol at lf only `.gitattributes` converts, and it travels
// in the tree; safecrlf refuses a conversion that would not come back byte
// for byte. fileMode on, so a chmod the engine made is staged even in a
// checkout that was told to ignore modes. ignoreCase off, so an untracked `A`
// beside a tracked `a` is listed; symlinks on, so a file that replaced a
// tracked link is staged as the file it is. No attributes file outside the
// tree: the default one lives under the engine's HOME. No replace refs: they
// stay in the workspace, and HEAD read through one names a tree the bundled
// commit does not have. Full stat checks with ctime, so a file rewritten to
// its old size and mtime is still listed as changed when staging is sized;
// only one rewritten within the second its index entry was refreshed slips
// through (git keeps whole-second ctimes unless built with USE_NSEC), and
// what that stages is bounded by the tracked bytes the workspace quota holds.
//
// One pack thread, for `checkpointGitLimits`: each thread takes a malloc
// arena of its own out of the address space, and left alone git starts one
// per host CPU whatever the container's CPU share. `index-pack` reads the
// same setting, so a restore's delta resolution is one thread too.
export const CHECKPOINT_GIT_CONFIG: Array<[string, string]> = [
  ["core.attributesFile", "/dev/null"],
  ["core.autocrlf", "false"],
  ["core.checkStat", "default"],
  ["core.eol", "lf"],
  ["core.fileMode", "true"],
  ["core.ignoreCase", "false"],
  ["core.safecrlf", "true"],
  ["core.symlinks", "true"],
  ["core.trustctime", "true"],
  ["core.useReplaceRefs", "false"],
  ["pack.threads", "1"],
];

/**
 * Address space for each capture or restore git: resolving a delta of a file
 * near `maxFileBytes` holds base and result at once (a 480 MiB file with one
 * edit peaked at 964 MiB resident; see the control plane's
 * `DEFAULT_MAX_GIT_MEMORY_BYTES`, which this matches), and so does staging
 * one that needs converting. Deliberately fixed rather than sized from the
 * container's memory; make it configurable once a deployment changes
 * `WORKER_MEMORY_MB` enough that the two disagree.
 */
const CHECKPOINT_GIT_MEMORY_BYTES = 1536 * 1024 * 1024;
/** Compression's worst case on top of the largest file: zlib adds ~0.03%. */
const FILE_SIZE_SLACK_BYTES = 16 * 1024 * 1024;

/**
 * What each git in a capture or a restore may use, so that a repository the
 * engine built cannot take the worker's memory, disk or CPU with it. The
 * largest file either writes is a tracked file (as a loose object, or back
 * into the tree) or the index; packs are bounded by the bundle, well below.
 * CPU gets the wall-clock deadline: one thread cannot use more, and a helper
 * left running after git exits gets no more than that either.
 */
export function checkpointGitLimits(
  limits: WorkspaceCaptureLimits = DEFAULT_WORKSPACE_CAPTURE_LIMITS,
): GitResourceLimits {
  return {
    cpuSeconds: Math.ceil(LOCAL_DEADLINE_MS / 1000),
    fileSizeBytes:
      Math.max(limits.maxFileBytes, limits.maxIndexBytes) +
      FILE_SIZE_SLACK_BYTES,
    memoryBytes: CHECKPOINT_GIT_MEMORY_BYTES,
  };
}

/**
 * What any one git call in a capture may print before it is killed: the
 * tracked-file listings grow with the repository, and nothing else bounds
 * them.
 */
const OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
/** The longest path Linux hands back, plus its NUL. */
const PATH_BYTES = 4096 + 1;

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
 * - `refs/checkpoint/instructions`: the `instructions` commit, when given.
 *   It comes from the caller's memory, never from a ref the engine can move.
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
 *
 * Git reads the repository's metadata as the engine left it, links
 * included: `.git/objects` or a ref pointed elsewhere is followed, and what
 * it reaches is bundled into this session's own checkpoint. That grants
 * nothing, because the engine runs as the worker's user and can read, and
 * commit, whatever this can. Running the engine under a user of its own
 * would make it a boundary; capture then has to read metadata the way
 * restore writes files, without following links.
 */
export async function captureWorkspace(input: {
  root: string;
  signal: AbortSignal;
  limits?: WorkspaceCaptureLimits;
  instructions?: InstructionsPin;
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
    const gitLimits = checkpointGitLimits(limits);
    const runBytes = (
      args: string[],
      env: Record<string, string>,
      maxStdoutBytes = OUTPUT_LIMIT_BYTES,
    ) =>
      runGitBytes(args, {
        cwd: root,
        extra: { config: CHECKPOINT_GIT_CONFIG, env },
        limits: gitLimits,
        maxStdoutBytes,
        network: null,
        overrides: neutralized,
        redact: (text) => text,
        signal,
      });
    const run = async (
      args: string[],
      env: Record<string, string>,
    ): Promise<GitResult> => {
      const result = await runBytes(args, env);
      return { ...result, stdout: new TextDecoder().decode(result.stdout) };
    };
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
    // Copied, bounded, before any git command reads it: an index a previous
    // engine grew to gigabytes would otherwise be loaded whole by the checks.
    const index = join(scratch, "index");
    const copied = await copyIndex(gitDirectory, index, limits.maxIndexBytes);
    if (copied !== undefined) return refused(copied);
    const indexed: Git = (args) =>
      run(args, {
        GIT_DIR: gitDirectory,
        GIT_INDEX_FILE: index,
        GIT_WORK_TREE: root,
      });
    const problem = await unrepresentable(indexed, gitDirectory);
    if (problem !== undefined) return refused(problem);
    const staged = await trackedSizes(
      (args) =>
        runBytes(args, {
          GIT_DIR: gitDirectory,
          GIT_INDEX_FILE: index,
          GIT_WORK_TREE: root,
        }),
      root,
      limits,
      signal,
    );
    if (staged !== undefined) return refused(staged);
    await check(
      run(["init", "--quiet", "--bare", repository], {}),
      "init scratch",
    );
    const pin = input.instructions;
    await writeFile(
      join(repository, "objects", "info", "alternates"),
      [join(gitDirectory, "objects"), pin?.objects]
        .filter((directory) => directory !== undefined)
        .map((directory) => `${directory}\n`)
        .join(""),
    );
    // Stages into the copy and writes objects into the scratch repository;
    // the workspace's own index and object store are only read. The scratch
    // repository is the GIT_DIR too, so nothing only the workspace's
    // repository holds — `info/attributes`, its config — shapes what is
    // staged: a restore has neither.
    // `--renormalize` re-reads every tracked file rather than trusting the
    // index's stat data, which an edit that kept size and mtime slips past.
    // Deliberately simple: every capture hashes the whole tree; revisit with
    // 94S-227 if that shows in turn latency.
    const staging: GitExtras["env"] = {
      GIT_DIR: repository,
      GIT_INDEX_FILE: index,
      GIT_WORK_TREE: root,
    };
    const stage = (args: string[], env: Record<string, string> = {}) =>
      run(args, { ...staging, ...env });
    let added = await stage(["add", "--update", "--", "."]);
    if (added.code === 0) {
      added = await stage(["add", "--renormalize", "--", "."]);
    }
    if (added.code !== 0) {
      return refused(`the working tree cannot be staged: ${lastLine(added)}`);
    }
    const endings = await lineEndingProblem((args) => runBytes(args, staging));
    if (endings !== undefined) return refused(endings);
    // `ident` collapses `$Id: <blob> $` as it stages, and a checkout expands
    // it to the new blob's id: a changed file would come back with other
    // bytes than it had.
    const expanded = await required(
      stage([
        "diff-index",
        "--cached",
        "--name-only",
        headCommit,
        "--",
        ":(attr:ident)",
      ]),
      "diff-index",
    );
    const identFile = expanded.split("\n").find((path) => path !== "");
    if (identFile !== undefined) {
      return refused(
        `${identFile} has the ident attribute and changed, and a restore would rewrite its $Id$`,
      );
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

    // Bytes, decoded strictly: a lossy decode turns an untracked `a\xff`
    // into `a\ufffd`, which may be another file entirely — an ignored one.
    let listed: Uint8Array;
    try {
      // Against the workspace's repository: a file its own excludes leave
      // out is left out like an ignored one.
      const others = await runBytes(
        ["ls-files", "-z", "--others", "--exclude-standard"],
        { GIT_DIR: gitDirectory, GIT_INDEX_FILE: index, GIT_WORK_TREE: root },
        (limits.maxUntrackedFiles + 1) * PATH_BYTES,
      );
      if (others.code !== 0) {
        throw new Error(
          `git ls-files failed (exit ${others.code}): ${others.stderr.trim()}`,
        );
      }
      listed = others.stdout;
    } catch (error) {
      if (!(error instanceof GitOutputLimitError)) throw error;
      return refused(
        `more untracked files than the ${limits.maxUntrackedFiles} a checkpoint carries`,
      );
    }
    const others = namesOf(listed);
    if (others === undefined) {
      return refused("an untracked file's name is not valid UTF-8");
    }
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
    if (pin !== undefined) {
      // Gone once the engine pruned what no ref of its own still reached.
      const present = await bundling([
        "cat-file",
        "-e",
        `${pin.commit}^{commit}`,
      ]);
      if (present.code !== 0) {
        return refused(
          `the instructions commit ${pin.commit} is no longer in the repository`,
        );
      }
      refs.push([CHECKPOINT_INSTRUCTIONS_REF, pin.commit]);
    }
    for (const [name, oid] of refs) {
      await check(bundling(["update-ref", name, oid]), "update-ref");
    }
    // Written to stdout and cut off at the limit, so an oversized history
    // costs the limit in memory and nothing on disk.
    let bundle: Uint8Array;
    try {
      const created = await runBytes(
        ["bundle", "create", "--quiet", "-", ...refs.map(([name]) => name)],
        { GIT_DIR: repository },
        limits.maxBundleBytes,
      );
      if (created.code !== 0) {
        throw new Error(
          `git bundle create failed (exit ${created.code}): ${created.stderr.trim()}`,
        );
      }
      bundle = created.stdout;
    } catch (error) {
      if (!(error instanceof GitOutputLimitError)) throw error;
      return refused(
        `the workspace bundle is over the ${limits.maxBundleBytes} bytes the control plane verifies`,
      );
    }

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
      untracked.push({ bytes: read.bytes, executable: read.executable, path });
    }
    return { status: "captured", capture: { bundle, gitCommit, untracked } };
  } catch (error) {
    // Any git in the capture that ran past what it may use or print, where
    // no step above has a more specific reason.
    if (
      error instanceof GitResourceLimitError ||
      error instanceof GitOutputLimitError
    ) {
      return refused(error.message);
    }
    throw error;
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
 * Every tracked file on disk against `maxFileBytes`, and what staging would
 * write into the scratch object store against `maxStagedBytes`: the tracked
 * files whose disk content differs from the index, by their size on disk (an
 * upper bound on the loose objects they become). Once a `.gitattributes` has
 * changed, `--renormalize` may rewrite any tracked file, so every one counts.
 */
async function trackedSizes(
  git: (
    args: string[],
  ) => Promise<{ code: number; stderr: string; stdout: Uint8Array }>,
  root: string,
  limits: WorkspaceCaptureLimits,
  signal: AbortSignal,
): Promise<string | undefined> {
  const listing = async (args: string[]) => {
    const listed = await git(["ls-files", "-z", ...args]);
    if (listed.code !== 0) {
      throw new Error(
        `git ls-files failed (exit ${listed.code}): ${listed.stderr.trim()}`,
      );
    }
    return listed.stdout;
  };
  const rules = await listing([
    "--modified",
    "--others",
    "--exclude-standard",
    "--",
    ":(glob)**/.gitattributes",
  ]);
  // Decoded as strictly as the untracked names, or lstat measures a
  // different file than the one `add -u` is about to write.
  const tracked = namesOf(await listing(["--cached"]));
  const modified =
    rules.byteLength > 0 ? tracked : namesOf(await listing(["--modified"]));
  if (tracked === undefined || modified === undefined) {
    return "a tracked file's name is not valid UTF-8";
  }
  const changed = new Set(modified.split("\0"));
  let total = 0;
  for (const path of new Set(tracked.split("\0"))) {
    if (path === "") continue;
    signal.throwIfAborted();
    const found = await lstat(join(root, path)).catch(() => null);
    // A link is staged as a blob of its target, which lstat sizes.
    if (found === null || !(found.isFile() || found.isSymbolicLink())) {
      continue;
    }
    if (found.size > limits.maxFileBytes) {
      return `${path} is ${found.size} bytes, over the ${limits.maxFileBytes} a checkpoint restores`;
    }
    if (!changed.has(path)) continue;
    total += found.size;
    if (total > limits.maxStagedBytes) {
      return `the tracked changes are over the ${limits.maxStagedBytes} bytes a checkpoint stages`;
    }
  }
  return undefined;
}

/**
 * Copies the workspace index without following a symlink planted in its
 * place; the copy is what gets staged into. A missing index is refused, not
 * read as empty: staging into an empty one would drop every tracked file an
 * ignore rule matches, and list the rest as untracked.
 */
async function copyIndex(
  gitDirectory: string,
  destination: string,
  limit: number,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      join(gitDirectory, "index"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return "the workspace has no index";
    if (code === "ELOOP") return "the workspace index is a symlink";
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "the workspace index is not a regular file";
    if (info.size > limit) {
      return `the workspace index is ${info.size} bytes, over the ${limit} a checkpoint reads`;
    }
    // One byte past what fstat said, so an index still growing is noticed.
    const buffer = new Uint8Array(info.size + 1);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.byteLength - filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled !== info.size)
      return "the workspace index changed while it was read";
    await writeFile(destination, buffer.subarray(0, filled));
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A tracked file whose line endings on disk are not what checking out its
 * staged blob writes under `CHECKPOINT_GIT_CONFIG`, which is how a restore writes
 * it. Staging normalizes a text file's line endings into the blob, so a file
 * the engine's own config wrote with CRLF (`core.eol`, `core.autocrlf`), or
 * one a `.gitattributes` edit since left stale, would come back different
 * without anything failing. `ls-files --eol` reads the working tree itself
 * rather than trusting the index's stat data.
 */
async function lineEndingProblem(
  git: (
    args: string[],
  ) => Promise<{ code: number; stderr: string; stdout: Uint8Array }>,
): Promise<string | undefined> {
  const listed = await git(["ls-files", "--eol", "-z"]);
  if (listed.code !== 0) {
    throw new Error(
      `git ls-files failed (exit ${listed.code}): ${listed.stderr.trim()}`,
    );
  }
  const entries = namesOf(listed.stdout);
  if (entries === undefined) return "a tracked file's name is not valid UTF-8";
  for (const entry of entries.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const info = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*)$/.exec(entry.slice(0, tab));
    if (tab < 0 || info === null) {
      throw new Error(`git ls-files --eol printed ${JSON.stringify(entry)}`);
    }
    const [, staged, disk, attributes] = info as unknown as [
      string,
      string,
      string,
      string,
    ];
    const attribute = attributes.trim().split(/\s+/);
    // `eol` implies `text`; `text=auto` converts only what git calls text.
    const converted =
      !attribute.includes("-text") &&
      (attribute.includes("text") ||
        attribute.some((value) => value.startsWith("eol=")) ||
        (attribute.includes("text=auto") && staged !== "-text"));
    if (!converted) continue;
    const written = attribute.includes("eol=crlf") ? "crlf" : "lf";
    const differs =
      written === "lf"
        ? disk === "crlf" || disk === "mixed"
        : disk === "lf" || disk === "mixed";
    if (differs) {
      return `${entry.slice(tab + 1)} has ${disk} line endings on disk, and a restore would write ${written}`;
    }
  }
  return undefined;
}

/**
 * NUL-separated names as git listed them, or undefined when they are not
 * UTF-8. Strict, because a lossy decode turns `a\xff` into `a\ufffd`, which
 * may be another file entirely; and a leading U+FEFF is part of the name
 * (`\ufeff.env` is not `.env`), not a byte-order mark to drop.
 */
function namesOf(listed: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      listed,
    );
  } catch {
    return undefined;
  }
}

export async function required(
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
