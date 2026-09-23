import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real `git bundle` output for tests about checkpoints.
 *
 * A hand-rolled byte string would pass the manifest's digest check and then
 * tell us nothing about whether git would accept it, which is the only thing
 * the workspace side of a checkpoint rests on. So the fixture is a throwaway
 * repository git itself bundles.
 */

export type GitBundleFixture = {
  readonly bytes: Uint8Array;
  /** Tip of `ref`, and what a manifest pins as `workspace.gitCommit`. */
  readonly commit: string;
  readonly ref: string;
  readonly sha256: string;
};

export async function createGitBundle(
  options: {
    readonly branch?: string;
    /** What the one committed file holds; defaults to the message. */
    readonly contents?: Uint8Array;
    readonly message?: string;
  } = {},
): Promise<GitBundleFixture> {
  const branch = options.branch ?? "main";
  const directory = await mkdtemp(join(tmpdir(), "testkit-bundle-"));
  try {
    await git(directory, "init", `--initial-branch=${branch}`, ".");
    await writeFile(
      join(directory, "file.txt"),
      options.contents ?? `${options.message ?? "x"}\n`,
    );
    await git(directory, "add", "file.txt");
    await git(directory, "commit", "-m", options.message ?? "checkpoint");
    const commit = (await git(directory, "rev-parse", "HEAD")).trim();
    const path = join(directory, "workspace.bundle");
    await git(directory, "bundle", "create", path, branch);
    const bytes = new Uint8Array(await readFile(path));
    return {
      bytes,
      commit,
      ref: `refs/heads/${branch}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const handle = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "testkit@example.invalid",
      GIT_AUTHOR_NAME: "Testkit",
      GIT_COMMITTER_EMAIL: "testkit@example.invalid",
      GIT_COMMITTER_NAME: "Testkit",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    handle.exited,
    new Response(handle.stderr).text(),
    new Response(handle.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}
