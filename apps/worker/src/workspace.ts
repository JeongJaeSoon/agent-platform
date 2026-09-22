import { readdir, rm, stat } from "node:fs/promises";
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
  options?: { cwd?: string; authenticated?: boolean },
) => Promise<GitResult>;

/**
 * Carries out `planWorkspacePreparation` with the `git` on this image.
 *
 * The repository URL may embed a credential (the descriptor keeps userinfo
 * on purpose). The engine runs in this checkout with tools that can read
 * and write `.git`, and a reused checkout is whatever the last attempt's
 * engine left there, so:
 * - origin is stored without the credential;
 * - only clone and fetch get it, from a one-shot credential helper fed
 *   through that one process's environment, and the helper answers only
 *   for the descriptor's own protocol and host, so a rewritten remote
 *   (`url.*.insteadOf`) cannot collect it;
 * - no git command here runs repository hooks or an fsmonitor.
 * Failures are reported with the URL replaced.
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
    const redact = redactor(url);
    const git: Git = (args, options = {}) =>
      runGit(
        args,
        options.cwd ?? this.root,
        input.signal,
        redact,
        options.authenticated === true ? remote.secret : null,
      );
    const plan = planWorkspacePreparation({
      workspace: input.descriptor,
      restore: input.restore,
      observed: await this.observe(git),
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
        await check(
          git(["fetch", "--quiet", "origin"], { authenticated: true }),
          "fetch",
        );
        await check(git(["checkout", "--quiet", plan.branch]), "checkout");
        return plan.action;
    }
  }

  private async observe(git: Git): Promise<WorkspaceObservation> {
    const entries = await readdir(this.root).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    if (entries.length === 0) return { kind: "empty" };
    // A directory for a clone, a file for a linked worktree.
    if ((await stat(join(this.root, ".git")).catch(() => null)) === null) {
      return { kind: "foreign" };
    }
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
    const probes = await Promise.all([
      git(["status", "--porcelain", "--untracked-files=all"]),
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
    return probes.some(
      (probe) => probe.code !== 0 || probe.stdout.trim() !== "",
    );
  }

  private async clone(git: Git, url: string, branch: string): Promise<void> {
    // Run from the parent: the root may not exist yet, and git creates it.
    await check(
      git(["clone", "--quiet", "--branch", branch, "--", url, this.root], {
        authenticated: true,
        cwd: join(this.root, ".."),
      }),
      "clone",
    );
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
  protocol: string;
  username: string;
};

/** The URL git may store, and the userinfo it may not. */
function splitSecret(url: string): { url: string; secret: Secret | null } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // scp-like syntax (git@host:path) carries a user name, never a secret.
    return { url, secret: null };
  }
  if (parsed.username === "" && parsed.password === "") {
    return { url, secret: null };
  }
  const secret = {
    host: parsed.host,
    password: decodeURIComponent(parsed.password),
    protocol: parsed.protocol.replace(/:$/, ""),
    username: decodeURIComponent(parsed.username),
  };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString(), secret };
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

function gitEnvironment(secret: Secret | null): Record<string, string> {
  const env: Record<string, string> = {
    // A credential prompt would hang the claim; fail instead.
    GIT_TERMINAL_PROMPT: "0",
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
  ];
  if (secret !== null) {
    // The empty helper first drops every helper configured anywhere else.
    config.push(
      ["credential.helper", ""],
      ["credential.helper", SCOPED_HELPER],
    );
    Object.assign(env, {
      WORKER_GIT_HOST: secret.host,
      WORKER_GIT_PASSWORD: secret.password,
      WORKER_GIT_PROTOCOL: secret.protocol,
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
  cwd: string,
  signal: AbortSignal,
  redact: (text: string) => string,
  secret: Secret | null,
): Promise<GitResult> {
  signal.throwIfAborted();
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: gitEnvironment(secret),
    signal,
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

/** Replaces the URL, and any userinfo git echoes back, in text meant for a log. */
function redactor(url: string): (text: string) => string {
  return (text) =>
    text
      .split(url)
      .join("<repository>")
      .replace(/(\/\/)[^/@\s]+@/g, "$1<redacted>@");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
