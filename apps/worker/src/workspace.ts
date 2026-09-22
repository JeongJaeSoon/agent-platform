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

/**
 * Carries out `planWorkspacePreparation` with the `git` on this image.
 *
 * The repository URL may embed a credential (the descriptor keeps userinfo
 * on purpose). The engine runs in this checkout with tools that can read
 * `.git/config`, so the credential is split off: origin is stored without
 * it, and git gets it from a one-shot credential helper fed through the
 * environment of that one git process. Failures are reported with the URL
 * replaced.
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
    const remote = splitCredential(url);
    const redact = redactor(url);
    const git = (args: string[], cwd = this.root) =>
      runGit(args, cwd, input.signal, redact, remote.credential);
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
        await check(git(["fetch", "--quiet", "origin"]), "fetch");
        await check(git(["checkout", "--quiet", plan.branch]), "checkout");
        return plan.action;
    }
  }

  private async observe(
    git: (args: string[]) => Promise<GitResult>,
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
  private async holdsLocalWork(
    git: (args: string[]) => Promise<GitResult>,
  ): Promise<boolean> {
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

  private async clone(
    git: (args: string[], cwd?: string) => Promise<GitResult>,
    url: string,
    branch: string,
  ): Promise<void> {
    // Run from the parent: the root may not exist yet, and git creates it.
    await check(
      git(
        ["clone", "--quiet", "--branch", branch, "--", url, this.root],
        join(this.root, ".."),
      ),
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

type Credential = { username: string; password: string };

/** The URL git may store, and the userinfo it may not. */
function splitCredential(url: string): {
  url: string;
  credential: Credential | null;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // scp-like syntax (git@host:path) carries a user name, never a secret.
    return { url, credential: null };
  }
  if (parsed.username === "" && parsed.password === "") {
    return { url, credential: null };
  }
  const credential = {
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString(), credential };
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

function gitEnvironment(credential: Credential | null): Record<string, string> {
  const env: Record<string, string> = {
    // A credential prompt would hang the claim; fail instead.
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of GIT_HOST_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (credential !== null) {
    // Config through the environment, so the secret is on no command line;
    // the empty helper first drops any helper the image configures.
    Object.assign(env, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1:
        '!f() { echo "username=$WORKER_GIT_USERNAME"; echo "password=$WORKER_GIT_PASSWORD"; }; f',
      WORKER_GIT_PASSWORD: credential.password,
      WORKER_GIT_USERNAME: credential.username,
    });
  }
  return env;
}

async function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  redact: (text: string) => string,
  credential: Credential | null,
): Promise<GitResult> {
  signal.throwIfAborted();
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: gitEnvironment(credential),
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
