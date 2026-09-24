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

/**
 * Two bundles git wrote as a chain (94S-227): `base` stands alone with the
 * first commit, and `tip` carries only the second, needing the first as its
 * prerequisite.
 */
export async function createGitBundleChain(): Promise<{
  readonly base: GitBundleFixture;
  readonly tip: GitBundleFixture;
}> {
  const directory = await mkdtemp(join(tmpdir(), "testkit-chain-"));
  const bundled = async (
    name: string,
    commit: string,
    ...revisions: string[]
  ): Promise<GitBundleFixture> => {
    const path = join(directory, `${name}.bundle`);
    await git(directory, "bundle", "create", path, ...revisions);
    const bytes = new Uint8Array(await readFile(path));
    return {
      bytes,
      commit,
      ref: "refs/heads/main",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  try {
    await git(directory, "init", "--initial-branch=main", ".");
    const commitOf = async (contents: string) => {
      await writeFile(join(directory, "file.txt"), contents);
      await git(directory, "add", "file.txt");
      await git(directory, "commit", "-m", contents);
      return (await git(directory, "rev-parse", "HEAD")).trim();
    };
    const first = await commitOf("first\n");
    const base = await bundled("base", first, "main");
    const second = await commitOf("second\n");
    const tip = await bundled("tip", second, "main", `^${first}`);
    return { base, tip };
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

/**
 * Asks a workspace bundle verifier about bytes held in memory, the way the
 * checkpoint service asks: from a file of their own that exists only for the
 * call. Typed structurally so testkit need not depend on platform.
 */
export async function verifyBundleBytes<T>(
  verifier: {
    verify(input: {
      readonly bytes: number;
      readonly commit: string;
      readonly key: string;
      readonly path: string;
    }): Promise<T>;
  },
  input: {
    readonly bytes: Uint8Array;
    readonly commit: string;
    readonly key: string;
  },
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "testkit-verify-"));
  try {
    const path = join(directory, "workspace.bundle");
    await writeFile(path, input.bytes);
    return await verifier.verify({
      ...input,
      bytes: input.bytes.byteLength,
      path,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
