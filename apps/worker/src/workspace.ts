import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type {
  CheckpointRef,
  WorkspaceDescriptor,
} from "@agent-platform/contracts";
import {
  type GitResourceLimits,
  gitCommand,
  killProcessGroup,
  planWorkspacePreparation,
  type WorkspaceObservation,
  type WorkspacePlan,
} from "@agent-platform/runtime-core";

/** What the host needs from a workspace before it starts an engine in it. */
export interface WorkspacePreparer {
  /**
   * Leaves the session's repository checked out at the root, or throws.
   * `restore` wins over the descriptor; restoring is the checkpoint port's
   * job (94S-246), so that plan comes back untouched.
   */
  prepare(input: {
    descriptor: WorkspaceDescriptor;
    restore: CheckpointRef | null;
    signal: AbortSignal;
  }): Promise<WorkspacePlan["action"]>;
  /**
   * The repository's root CLAUDE.md as committed on the session's branch,
   * read by the last `prepare` from what it had just fetched and before any
   * engine ran; null when there is none. Throws when the committed file is
   * one the worker will not hand over (see `readCommittedClaudeMd`), or when
   * that `prepare` fetched nothing to read it from (a restore).
   */
  committedClaudeMd(): string | null;
  /**
   * The commit `committedClaudeMd` was read from, which checkpoints carry
   * forward (`CHECKPOINT_INSTRUCTIONS_REF`); null when nothing was fetched.
   */
  instructionsCommit(): string | null;
}

/** For hosts whose engine never touches a repository, like the fake. */
export const noWorkspace: WorkspacePreparer = {
  async prepare() {
    return "reuse";
  },
  committedClaudeMd: () => null,
  instructionsCommit: () => null,
};

/**
 * Past this the run is refused rather than handed part of the file: a cut can
 * drop the rule that mattered or end one mid-sentence, and a model cannot
 * tell a truncated policy from a complete one.
 */
export const COMMITTED_CLAUDE_MD_MAX_BYTES = 64 * 1024;

export type CommittedClaudeMd =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "refused"; reason: string };

/** CLAUDE.md as read, and the commit it was read from. */
export type PinnedInstructions = {
  claudeMd: CommittedClaudeMd;
  commit: string | null;
};

const NOTHING_PINNED: PinnedInstructions = {
  claudeMd: { kind: "absent" },
  commit: null,
};

/** How `committedClaudeMd` answers for what `pinInstructions` found. */
export function committedClaudeMdOf(
  claudeMd: CommittedClaudeMd,
): string | null {
  switch (claudeMd.kind) {
    case "text":
      return claudeMd.text;
    case "absent":
      return null;
    case "refused":
      throw new Error(`Repository CLAUDE.md refused: ${claudeMd.reason}`);
  }
}

export type GitResult = { code: number; stdout: string; stderr: string };
export type Git = (
  args: string[],
  options?: { cwd?: string; network?: boolean },
) => Promise<GitResult>;

/**
 * Carries out `planWorkspacePreparation` with the `git` on this image.
 *
 * The repository URL may embed a credential (the descriptor keeps userinfo
 * on purpose). The engine runs in this checkout with tools that can read
 * and write `.git`, and a reused checkout is whatever the last attempt's
 * engine left there, so:
 * - origin is stored without the credential;
 * - the network is only ever reached from a repository this worker has
 *   just created (a clone into the empty root, or a scratch mirror for a
 *   reuse), never through the reused checkout's config, whose
 *   `insteadOf`, `sshCommand` or `askPass` could run the engine's code
 *   with the credential in its environment;
 * - those network calls get the credential from a helper that answers
 *   only the descriptor's protocol and host, may use only that protocol,
 *   and read no global or system config (HOME is the engine's too);
 * - no git command here runs a hook, an fsmonitor, a filter driver the
 *   checkout's config defines, or recurses into a submodule, and each one
 *   is killed past a deadline, so a planted command can neither run nor
 *   wedge the claim while the heartbeat keeps its lease alive.
 * Failures are reported with the URL and the credential replaced.
 *
 * Deliberately minimal: a clone takes whatever history the remote serves,
 * with no depth or size limit beyond the workspace volume's own (94S-215).
 * Revisit when clone time starts eating the claim's lease budget.
 */
export class GitWorkspace implements WorkspacePreparer {
  private instructions: PinnedInstructions = NOTHING_PINNED;

  constructor(private readonly root: string) {}

  committedClaudeMd(): string | null {
    return committedClaudeMdOf(this.instructions.claudeMd);
  }

  instructionsCommit(): string | null {
    return this.instructions.commit;
  }

  async prepare(input: {
    descriptor: WorkspaceDescriptor;
    restore: CheckpointRef | null;
    signal: AbortSignal;
  }): Promise<WorkspacePlan["action"]> {
    const { url } = input.descriptor.repository;
    const remote = splitSecret(url);
    const redact = redactor(url, remote.secret);
    // Filled in once the checkout's filter drivers are known.
    const neutralized: Array<[string, string]> = [];
    const git: Git = (args, options = {}) =>
      runGit(args, {
        cwd: options.cwd ?? this.root,
        network: options.network === true ? remote : null,
        overrides: neutralized,
        redact,
        signal: input.signal,
      });
    this.instructions = NOTHING_PINNED;
    if (input.restore !== null) {
      // Decided before anything reads the checkout: the restorer replaces it
      // whole, and a half-restored one (a stopped earlier attempt) may have a
      // config `observe` cannot even read. Nothing was fetched, so there is
      // no commit to read instructions from here; the restorer reads them
      // from the one the checkpoint pinned (`RuntimeResumePlan`). Refused
      // rather than absent, so a port that does not would fail the claim
      // instead of resuming without them.
      this.instructions = {
        claudeMd: {
          kind: "refused",
          reason:
            "a restored workspace has no freshly fetched commit behind it",
        },
        commit: null,
      };
      return "restore";
    }
    const plan = planWorkspacePreparation({
      workspace: input.descriptor,
      restore: null,
      observed: await this.observe(git, neutralized),
    });
    switch (plan.action) {
      case "restore":
        throw new Error("A workspace with no checkpoint planned a restore");
      case "refuse":
        throw new Error(`Workspace ${this.root} refused: ${plan.reason}`);
      case "recreate":
        await this.empty();
        await this.clone(git, remote.url, plan.branch);
        // A fresh clone nothing has run in yet.
        this.instructions = await pinInstructions(
          git,
          this.root,
          `refs/remotes/origin/${plan.branch}`,
          input.signal,
        );
        return plan.action;
      case "clone":
        await this.clone(git, remote.url, plan.branch);
        // A fresh clone nothing has run in yet.
        this.instructions = await pinInstructions(
          git,
          this.root,
          `refs/remotes/origin/${plan.branch}`,
          input.signal,
        );
        return plan.action;
      case "reuse":
        // Also scrubs a credential an older worker may have stored.
        await check(
          git(["remote", "set-url", "origin", remote.url]),
          "remote set-url",
        );
        await this.fetchThroughMirror(
          git,
          remote.url,
          plan.branch,
          input.signal,
        );
        await check(git(["checkout", "--quiet", plan.branch]), "checkout");
        return plan.action;
    }
  }

  private async observe(
    git: Git,
    neutralized: Array<[string, string]>,
  ): Promise<WorkspaceObservation> {
    const entries = await readdir(this.root).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    if (entries.length === 0) return { kind: "empty" };
    // A directory for a clone, a file for a linked worktree.
    if ((await stat(join(this.root, ".git")).catch(() => null)) === null) {
      return { kind: "foreign" };
    }
    // Reading config runs nothing; everything after this may.
    neutralized.push(...(await filterOverrides(git)));
    const remote = await git(["config", "--get", "remote.origin.url"]);
    const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const shallow = await git(["rev-parse", "--is-shallow-repository"]);
    const fsck = await git(["fsck", "--connectivity-only", "--no-progress"]);
    return {
      kind: "checkout",
      remoteUrl: remote.code === 0 ? remote.stdout.trim() : "",
      branch: branch.code === 0 ? branch.stdout.trim() : null,
      healthy:
        fsck.code === 0 &&
        shallow.code === 0 &&
        shallow.stdout.trim() === "false",
      localWork: await this.holdsLocalWork(git),
    };
  }

  /**
   * True unless git can show there is nothing here that `origin` lacks. A
   * probe that fails counts as work: this answer decides whether a
   * checkout may be deleted.
   */
  private async holdsLocalWork(git: Git): Promise<boolean> {
    // Ignored files count: an unsound checkout with none of the other kinds
    // of work is deleted, and an ignored `.env` is still somebody's.
    const probes = await Promise.all([
      git([
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=all",
      ]),
      git([
        "rev-list",
        "--max-count=1",
        // A detached HEAD's commits are on no branch.
        "HEAD",
        "--branches",
        "--tags",
        "--not",
        "--remotes=origin",
      ]),
      git(["stash", "list"]),
    ]);
    // Submodules are never looked into (their config is the engine's too),
    // so having any is treated as holding work in them.
    const submodules = await stat(join(this.root, ".git", "modules")).catch(
      () => null,
    );
    return (
      submodules !== null ||
      probes.some((probe) => probe.code !== 0 || probe.stdout.trim() !== "")
    );
  }

  private async clone(git: Git, url: string, branch: string): Promise<void> {
    // Run from the parent: the root may not exist yet, and git creates it.
    await check(
      git(["clone", "--quiet", "--branch", branch, "--", url, this.root], {
        network: true,
        cwd: join(this.root, ".."),
      }),
      "clone",
    );
  }

  /**
   * Fetches origin into a mirror nobody else has written to, then copies
   * the branches over locally, where nothing carries the credential.
   *
   * Deliberately minimal: the mirror downloads the whole repository again
   * rather than negotiating from the checkout's objects, whose repository
   * config is exactly what this avoids trusting. Revisit when a reuse costs
   * noticeably more than the clone it saves.
   */
  private async fetchThroughMirror(
    git: Git,
    url: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<void> {
    const scratch = await mkdtemp(join(tmpdir(), "worker-fetch-"));
    const mirror = join(scratch, "origin.git");
    try {
      await check(
        git(["clone", "--quiet", "--bare", "--", url, mirror], {
          network: true,
          cwd: scratch,
        }),
        "fetch",
      );
      await check(
        git([
          "fetch",
          "--quiet",
          "--no-tags",
          mirror,
          "+refs/heads/*:refs/remotes/origin/*",
        ]),
        "fetch",
      );
      // From the mirror, not the checkout: the last attempt's engine could
      // have edited the working tree, committed on the branch, or planted
      // objects in `.git` that a fetch would not overwrite.
      // The commit is also in the checkout now, under origin's refs.
      this.instructions = await pinInstructions(
        git,
        mirror,
        `refs/heads/${branch}`,
        signal,
      );
    } finally {
      await rm(scratch, { force: true, recursive: true });
    }
  }

  /** The root is the backend's mount point: empty it, keep it. */
  private async empty(): Promise<void> {
    for (const entry of await readdir(this.root)) {
      await rm(join(this.root, entry), { force: true, recursive: true });
    }
  }
}

/** Enough for a CLAUDE.md -> AGENTS.md -> docs/... chain; more is a loop. */
const MAX_LINK_HOPS = 8;
/** Linux's PATH_MAX: no checkout could create a link to anything longer. */
const MAX_LINK_TARGET_BYTES = 4096;

/**
 * The root CLAUDE.md at `rev`, read from git's object store in `cwd` — never
 * from a working tree, which the engine writes. A committed symlink is
 * followed only to another path in the same tree (`CLAUDE.md -> AGENTS.md`
 * is ordinary); one that leaves it, loops, or ends at anything but a file is
 * refused, as is a file past the cap or one git cannot read. Refused, not
 * thrown: whether the run wants the file at all is the profile's call, made
 * later, and a session that never asked for it must not fail over it.
 *
 * Left out, against what the engine itself loads: `.claude/CLAUDE.md`,
 * `CLAUDE.local.md`, `.claude/rules/`, nested directories' files and `@`
 * imports — each is another path to resolve the same way, worth adding when
 * a repository the platform serves depends on one.
 */
/**
 * Resolves `rev` to the commit it names now and reads CLAUDE.md from that
 * commit, so the text and the commit a checkpoint later pins are the same.
 */
export async function pinInstructions(
  git: Git,
  cwd: string,
  rev: string,
  signal: AbortSignal,
): Promise<PinnedInstructions> {
  const resolved = await git(
    ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
    { cwd },
  );
  if (resolved.code !== 0) {
    return {
      claudeMd: { kind: "refused", reason: `${rev} names no commit` },
      commit: null,
    };
  }
  const commit = resolved.stdout.trim();
  return {
    claudeMd: await readCommittedClaudeMd(git, cwd, commit, signal),
    commit,
  };
}

export async function readCommittedClaudeMd(
  git: Git,
  cwd: string,
  rev: string,
  signal: AbortSignal,
): Promise<CommittedClaudeMd> {
  try {
    return await resolveCommittedClaudeMd(git, cwd, rev);
  } catch (error) {
    // A stop is the preparation's to report. Anything else that goes wrong
    // with this file is only the business of a profile that asks for it.
    if (signal.aborted) throw error;
    return {
      kind: "refused",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveCommittedClaudeMd(
  git: Git,
  cwd: string,
  rev: string,
): Promise<CommittedClaudeMd> {
  let path = "CLAUDE.md";
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const listed = await git(
      ["--literal-pathspecs", "ls-tree", "--full-tree", "-z", rev, "--", path],
      { cwd },
    );
    if (listed.code !== 0) {
      return {
        kind: "refused",
        reason: `git ls-tree failed (exit ${listed.code}): ${listed.stderr.trim()}`,
      };
    }
    // A pathspec naming a directory lists what is in it; only an entry for
    // exactly this path is the file (a link to nothing lists nothing).
    const entry = /^(\d+) (\w+) ([0-9a-f]+)\t([^\0]*)\0/.exec(listed.stdout);
    if (entry === null || entry[4] !== path) return { kind: "absent" };
    const [, mode, type, object] = entry as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (mode === "120000") {
      // Sized before it is read, like the file itself: on a reuse this runs
      // against a mirror before any checkout, where no filesystem limit on
      // link targets stands between a huge blob and this process's memory.
      const size = await git(["cat-file", "-s", object], { cwd });
      if (size.code !== 0) {
        return {
          kind: "refused",
          reason: `git cat-file failed (exit ${size.code}): ${size.stderr.trim()}`,
        };
      }
      if (Number(size.stdout.trim()) > MAX_LINK_TARGET_BYTES) {
        return { kind: "refused", reason: "it links to an overlong path" };
      }
      const target = await git(["cat-file", "blob", object], { cwd });
      if (target.code !== 0) {
        return {
          kind: "refused",
          reason: `git cat-file failed (exit ${target.code}): ${target.stderr.trim()}`,
        };
      }
      // A link is an arbitrary blob; no filesystem path holds a NUL.
      if (target.stdout.includes("\0")) {
        return { kind: "refused", reason: "it links to a malformed path" };
      }
      const next = posix.normalize(
        posix.join(posix.dirname(path), target.stdout),
      );
      if (
        posix.isAbsolute(target.stdout) ||
        next === ".." ||
        next.startsWith("../")
      ) {
        return { kind: "refused", reason: "it links outside the repository" };
      }
      // A pathspec that names a directory this way lists everything in it —
      // unbounded output from a read that runs for every session — and
      // whatever it names is no file anyway.
      if (next === "." || next.endsWith("/")) {
        return { kind: "refused", reason: "it is not a regular file" };
      }
      path = next;
      continue;
    }
    if (type !== "blob") {
      return { kind: "refused", reason: "it is not a regular file" };
    }
    const size = await git(["cat-file", "-s", object], { cwd });
    if (size.code !== 0) {
      return {
        kind: "refused",
        reason: `git cat-file failed (exit ${size.code}): ${size.stderr.trim()}`,
      };
    }
    if (Number(size.stdout.trim()) > COMMITTED_CLAUDE_MD_MAX_BYTES) {
      return {
        kind: "refused",
        reason: `it is larger than ${COMMITTED_CLAUDE_MD_MAX_BYTES} bytes`,
      };
    }
    const blob = await git(["cat-file", "blob", object], { cwd });
    if (blob.code !== 0) {
      return {
        kind: "refused",
        reason: `git cat-file failed (exit ${blob.code}): ${blob.stderr.trim()}`,
      };
    }
    return { kind: "text", text: blob.stdout };
  }
  return { kind: "refused", reason: "it links through too many symlinks" };
}

type Secret = {
  host: string;
  password: string;
  username: string;
};

type Remote = {
  /** What git may store: the URL without userinfo. */
  url: string;
  /** The one transport the network calls may use. */
  protocol: string;
  secret: Secret | null;
};

function splitSecret(url: string): Remote {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A plain path, or scp-like syntax (git@host:path), which carries a user
    // name but never a secret.
    return {
      url,
      protocol: url.startsWith("/") ? "file" : "ssh",
      secret: null,
    };
  }
  const protocol = parsed.protocol.replace(/:$/, "");
  if (parsed.username === "" && parsed.password === "") {
    return { url, protocol, secret: null };
  }
  const secret = {
    host: parsed.host,
    password: decodeURIComponent(parsed.password),
    username: decodeURIComponent(parsed.username),
  };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString(), protocol, secret };
}

/** The repository URL as git may store it: without the credential. */
export function storableRepositoryUrl(url: string): string {
  return splitSecret(url).url;
}

/** What git needs from the host: its binary, a HOME, and the egress proxy. */
const GIT_HOST_VARIABLES = [
  "PATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * Answers `get` only for the descriptor's protocol and host; git writes
 * `protocol=` and `host=` lines on stdin. Quoted case patterns match
 * literally.
 */
const SCOPED_HELPER = [
  "!f() {",
  'test "$1" = get || exit 0;',
  "p=; h=;",
  'while IFS= read -r line; do case "$line" in',
  '"protocol=$WORKER_GIT_PROTOCOL") p=1;;',
  '"host=$WORKER_GIT_HOST") h=1;;',
  "esac; done;",
  'test -n "$p" && test -n "$h" || exit 0;',
  'echo "username=$WORKER_GIT_USERNAME";',
  'echo "password=$WORKER_GIT_PASSWORD";',
  "}; f",
].join(" ");

/**
 * Every filter driver the checkout's config defines, emptied: git runs no
 * filter whose command is empty, and `required=false` keeps it from failing
 * the command instead.
 */
export async function filterOverrides(
  git: Git,
): Promise<Array<[string, string]>> {
  const listed = await git([
    "config",
    "--includes",
    "--name-only",
    "--get-regexp",
    "^filter\\.",
  ]);
  // Exit 1 is "no such key"; anything else leaves the drivers unknown.
  if (listed.code === 1) return [];
  if (listed.code !== 0) {
    throw new Error(
      `git config failed (exit ${listed.code}): ${listed.stderr}`,
    );
  }
  const drivers = new Set(
    listed.stdout
      .split("\n")
      .filter((key) => key.startsWith("filter."))
      .map((key) => key.slice("filter.".length, key.lastIndexOf(".")))
      .filter((name) => name !== ""),
  );
  return [...drivers].flatMap(
    (name): Array<[string, string]> => [
      [`filter.${name}.clean`, ""],
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"],
    ],
  );
}

/**
 * What a caller adds to the hardened environment: more configuration (it
 * still outranks the repository's own) and variables such as `GIT_DIR` or
 * `GIT_INDEX_FILE` that point a command at something other than the root.
 */
export type GitExtras = {
  config?: Array<[string, string]>;
  env?: Record<string, string>;
};

/** Long enough for a large clone; a local command gets far less. */
const NETWORK_DEADLINE_MS = 30 * 60_000;
export const LOCAL_DEADLINE_MS = 2 * 60_000;

/** `network` is null for calls that must not leave this machine. */
function gitEnvironment(
  network: Remote | null,
  overrides: Array<[string, string]>,
  extra: GitExtras = {},
): Record<string, string> {
  const env: Record<string, string> = {
    // A credential prompt would hang the claim; fail instead.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: network?.protocol ?? "file",
  };
  for (const name of GIT_HOST_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Config through the environment outranks the repository's own, which
  // the last attempt's engine could write.
  const config: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["submodule.recurse", "false"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ...overrides,
    ...(extra.config ?? []),
  ];
  const secret = network?.secret ?? null;
  if (network !== null && secret !== null) {
    // The empty helper first drops every helper configured anywhere else.
    config.push(
      ["credential.helper", ""],
      ["credential.helper", SCOPED_HELPER],
    );
    Object.assign(env, {
      WORKER_GIT_HOST: secret.host,
      WORKER_GIT_PASSWORD: secret.password,
      WORKER_GIT_PROTOCOL: network.protocol,
      WORKER_GIT_USERNAME: secret.username,
    });
  }
  Object.assign(env, extra.env);
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export type GitRunOptions = {
  cwd: string;
  /** For tests; otherwise set by whether git may reach the network. */
  deadlineMs?: number;
  extra?: GitExtras;
  /**
   * Caps git and every helper it forks (Linux only, see `gitCommand`); one
   * that runs out is reported as `GitResourceLimitError`. Unset, git shares
   * the worker's memory, disk and CPU.
   */
  limits?: GitResourceLimits;
  network: Remote | null;
  overrides: Array<[string, string]>;
  redact: (text: string) => string;
  signal: AbortSignal;
};

/** Git wrote more to stdout than the caller would hold; the child was killed. */
export class GitOutputLimitError extends Error {
  constructor(readonly limit: number) {
    super(`git wrote more than ${limit} bytes`);
    this.name = "GitOutputLimitError";
  }
}

/**
 * A git run under `GitRunOptions.limits` ran out of memory, file size, CPU
 * or its deadline. Thrown rather than returned as an exit code, so that
 * callers which read a failed probe as an answer do not read this one as one.
 */
export class GitResourceLimitError extends Error {
  constructor(detail: string) {
    super(`git ran out of its resource limits: ${detail}`);
    this.name = "GitResourceLimitError";
  }
}

/**
 * What git says on stderr is kept only up to this, from the end: enough for
 * the last lines a failure is reported and classified with, and not a buffer
 * a hostile repository fills.
 */
const STDERR_LIMIT_BYTES = 64 * 1024;

/**
 * How long the pipes are read once git itself has exited. A helper it forked
 * (`pack-objects`, `index-pack`) shares them, and one that outlives a git
 * that exited on its own would otherwise hold the read open for as long as it
 * runs. Such a helper is not killed (see `runGitBytes`): it runs on until its
 * next write fails, and under `limits` no longer than its own CPU allowance.
 */
const PIPE_GRACE_MS = 2_000;

/**
 * How git reports, in its last lines, a helper or an allocation that a limit
 * stopped. Read only from the end of stderr, where git's own verdict is, and
 * only for a run with limits; a path that happens to say the same can at
 * worst turn a failure into a limit failure, which fails the same way.
 */
const LIMIT_MESSAGES =
  /out of memory|cannot allocate memory|file too large|died of signal (9|24|25)\b/i;
const LIMIT_SIGNALS = new Set(["SIGKILL", "SIGXCPU", "SIGXFSZ"]);

export async function runGit(
  args: string[],
  options: GitRunOptions,
): Promise<GitResult> {
  const result = await runGitBytes(args, options);
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: result.stderr,
  };
}

/**
 * `runGit` with stdout as the bytes git wrote, for output that is not text
 * (a bundle) or whose names must not be decoded lossily. Past `maxStdoutBytes`
 * the child is killed and `GitOutputLimitError` thrown, so a limit is enforced
 * while git runs rather than after it has filled memory.
 *
 * git leads a process group of its own, and a stop — the signal, the
 * deadline, the stdout limit — kills the whole group: the helpers git forks
 * (`pack-objects`, `index-pack`) inherit its pipes and would otherwise run
 * on after it. Only while git itself has not been reaped, though; after that
 * its number may be someone else's group (see `killProcessGroup`).
 */
export async function runGitBytes(
  args: string[],
  options: GitRunOptions & { maxStdoutBytes?: number },
): Promise<{ code: number; stderr: string; stdout: Uint8Array }> {
  const { network, redact, signal } = options;
  signal.throwIfAborted();
  const child = Bun.spawn(gitCommand(args, options.limits), {
    cwd: options.cwd,
    detached: true,
    env: gitEnvironment(network, options.overrides, options.extra),
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      killProcessGroup(child.pid);
    }
  };
  const deadlineMs =
    options.deadlineMs ??
    (network === null ? LOCAL_DEADLINE_MS : NETWORK_DEADLINE_MS);
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, deadlineMs);
  signal.addEventListener("abort", stop);
  const limit = options.maxStdoutBytes ?? Number.POSITIVE_INFINITY;
  const abandon = child.exited.then(() => Bun.sleep(PIPE_GRACE_MS));
  let collected: [Collected, string, number];
  try {
    collected = await Promise.all([
      collect(child.stdout, limit, abandon, stop),
      collectTail(child.stderr, STDERR_LIMIT_BYTES, abandon),
      child.exited,
    ]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", stop);
  }
  const [stdout, stderr, code] = collected;
  signal.throwIfAborted();
  if (stdout.overflowed) throw new GitOutputLimitError(limit);
  const said = redact(stderr);
  const late = `git ran past its ${deadlineMs}ms deadline`;
  if (options.limits !== undefined) {
    if (timedOut) throw new GitResourceLimitError(late);
    if (!stopped && code !== 0) {
      const killedBy = child.signalCode ?? "";
      if (LIMIT_SIGNALS.has(killedBy)) {
        throw new GitResourceLimitError(killedBy);
      }
      const verdict = said
        .trim()
        .split("\n")
        .slice(-2)
        .find((line) => LIMIT_MESSAGES.test(line));
      if (verdict !== undefined) throw new GitResourceLimitError(verdict);
    }
  }
  return {
    code,
    stdout: stdout.bytes,
    stderr: timedOut ? `${said}\n${late}` : said,
  };
}

/**
 * Reads a pipe up to `limit` bytes. Without `onOverflow` the rest is drained
 * and dropped, so the writer never blocks on a full pipe; with it, reading
 * stops and the writer is expected to be killed. Reading also stops once
 * `abandon` settles, whoever still holds the pipe.
 */
const ABANDONED = Symbol("abandoned");

type Collected = { bytes: Uint8Array; overflowed: boolean };

async function collect(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abandon: Promise<void>,
  onOverflow?: () => void,
): Promise<Collected> {
  const chunks: Uint8Array[] = [];
  let held = 0;
  let overflowed = false;
  const reader = stream.getReader();
  const abandoned = abandon.then(() => ABANDONED);
  for (;;) {
    const next = await Promise.race([reader.read(), abandoned]);
    if (typeof next === "symbol") {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = next;
    if (done) break;
    if (overflowed) continue;
    if (held + value.byteLength > limit) {
      overflowed = true;
      const room = limit - held;
      if (room > 0) chunks.push(value.subarray(0, room));
      held = limit;
      if (onOverflow !== undefined) {
        onOverflow();
        await reader.cancel().catch(() => undefined);
        break;
      }
      continue;
    }
    chunks.push(value);
    held += value.byteLength;
  }
  const bytes = new Uint8Array(held);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflowed };
}

/**
 * The last `limit` bytes of a pipe, as whole lines: once anything has been
 * dropped the first, partial line goes too, so no cut lands inside a URL or
 * credential the redaction would then no longer recognise.
 */
async function collectTail(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abandon: Promise<void>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let held = 0;
  let dropped = false;
  const reader = stream.getReader();
  const abandoned = abandon.then(() => ABANDONED);
  for (;;) {
    const next = await Promise.race([reader.read(), abandoned]);
    if (typeof next === "symbol") {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = next;
    if (done) break;
    chunks.push(value);
    held += value.byteLength;
    while (held - (chunks[0]?.byteLength ?? 0) >= limit) {
      held -= chunks.shift()?.byteLength ?? 0;
      dropped = true;
    }
  }
  const bytes = new Uint8Array(held);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let kept = bytes;
  if (held > limit) {
    kept = bytes.subarray(held - limit);
    dropped = true;
  }
  if (dropped) kept = kept.subarray(kept.indexOf(0x0a) + 1);
  return new TextDecoder().decode(kept);
}

export async function check(
  result: Promise<GitResult>,
  step: string,
): Promise<void> {
  const { code, stderr } = await result;
  if (code !== 0) {
    throw new Error(`git ${step} failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** Replaces the URL, the credential, and any userinfo git echoes back. */
function redactor(
  url: string,
  secret: Secret | null,
): (text: string) => string {
  return (text) => {
    let redacted = text.split(url).join("<repository>");
    if (secret !== null && secret.password !== "") {
      redacted = redacted.split(secret.password).join("<redacted>");
    }
    return redacted.replace(/(\/\/)[^/@\s]+@/g, "$1<redacted>@");
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
