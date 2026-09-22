import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CheckpointRef,
  WorkspaceDescriptor,
} from "@agent-platform/contracts";
import {
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
}

/** For hosts whose engine never touches a repository, like the fake. */
export const noWorkspace: WorkspacePreparer = {
  async prepare() {
    return "reuse";
  },
};

type GitResult = { code: number; stdout: string; stderr: string };
type Git = (
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
  constructor(private readonly root: string) {}

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
    const plan = planWorkspacePreparation({
      workspace: input.descriptor,
      restore: input.restore,
      observed: await this.observe(git, neutralized),
    });
    switch (plan.action) {
      case "restore":
        return plan.action;
      case "refuse":
        throw new Error(`Workspace ${this.root} refused: ${plan.reason}`);
      case "recreate":
        await this.empty();
        await this.clone(git, remote.url, plan.branch);
        return plan.action;
      case "clone":
        await this.clone(git, remote.url, plan.branch);
        return plan.action;
      case "reuse":
        // Also scrubs a credential an older worker may have stored.
        await check(
          git(["remote", "set-url", "origin", remote.url]),
          "remote set-url",
        );
        await this.fetchThroughMirror(git, remote.url);
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
  private async fetchThroughMirror(git: Git, url: string): Promise<void> {
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
async function filterOverrides(git: Git): Promise<Array<[string, string]>> {
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

/** Long enough for a large clone; a local command gets far less. */
const NETWORK_DEADLINE_MS = 30 * 60_000;
const LOCAL_DEADLINE_MS = 2 * 60_000;

/** `network` is null for calls that must not leave this machine. */
function gitEnvironment(
  network: Remote | null,
  overrides: Array<[string, string]>,
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
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function runGit(
  args: string[],
  options: {
    cwd: string;
    network: Remote | null;
    overrides: Array<[string, string]>;
    redact: (text: string) => string;
    signal: AbortSignal;
  },
): Promise<GitResult> {
  const { network, redact, signal } = options;
  signal.throwIfAborted();
  const child = Bun.spawn(["git", ...args], {
    cwd: options.cwd,
    env: gitEnvironment(network, options.overrides),
    killSignal: "SIGKILL",
    signal,
    timeout: network === null ? LOCAL_DEADLINE_MS : NETWORK_DEADLINE_MS,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal.throwIfAborted();
  return { code, stdout, stderr: redact(stderr) };
}

async function check(result: Promise<GitResult>, step: string): Promise<void> {
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
