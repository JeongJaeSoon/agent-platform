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
 * Carries out `planWorkspacePreparation` with the `git` on this image. The
 * repository URL may embed a credential (the descriptor keeps userinfo on
 * purpose), so it is passed as an argument and never reaches a message:
 * every failure is reported with it replaced.
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
    const redact = redactor(url);
    const git = (args: string[], cwd = this.root) =>
      runGit(args, cwd, input.signal, redact);
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
        await this.clone(git, plan.url, plan.branch);
        return plan.action;
      case "clone":
        await this.clone(git, plan.url, plan.branch);
        return plan.action;
      case "reuse":
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

async function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  redact: (text: string) => string,
): Promise<GitResult> {
  signal.throwIfAborted();
  const child = Bun.spawn(["git", ...args], {
    cwd,
    // A credential prompt would hang the claim; fail instead.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
