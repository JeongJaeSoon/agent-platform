import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitBundle,
  type GitBundleFixture,
} from "@agent-platform/testkit/git-bundle";

import {
  createGitWorkspaceBundleVerifier,
  defaultGitRunner,
  GIT_TIMEOUT_EXIT_CODE,
  type GitCommandRunner,
} from "./index.ts";

let tempRoot: string;
let bundle: GitBundleFixture;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "verifier-test-"));
  bundle = await createGitBundle();
});

afterAll(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

/**
 * Same pack, different tip: the header claims a commit the pack never
 * delivered, which is exactly what the structural verifier cannot see.
 */
function withSwappedTip(fixture: GitBundleFixture): {
  bytes: Uint8Array;
  commit: string;
} {
  const text = new TextDecoder("latin1").decode(fixture.bytes);
  const headerEnd = text.indexOf("\n\n");
  const header = text.slice(0, headerEnd);
  const commit = "1".repeat(40);
  const swapped = header.replace(fixture.commit, commit);
  expect(swapped).not.toBe(header);
  const bytes = new Uint8Array(fixture.bytes);
  bytes.set(new TextEncoder().encode(swapped), 0);
  return { bytes, commit };
}

describe("git workspace bundle verifier", () => {
  test("a bundle git wrote is restorable", async () => {
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const verdict = await verifier.verify({
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(verdict).toEqual({ status: "restorable" });
  });

  test("a rewritten header over a whole pack is unusable", async () => {
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const swapped = withSwappedTip(bundle);
    const verdict = await verifier.verify({ ...swapped, key: "k" });
    expect(verdict.status).toBe("unusable");
    if (verdict.status === "unusable") {
      expect(verdict.reason).toContain("git fetch failed");
    }
  });

  test("bytes that fail the structural gate never start git", async () => {
    const calls: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    const verdict = await verifier.verify({
      bytes: bundle.bytes,
      commit: "0".repeat(40),
      key: "k",
    });
    expect(verdict).toEqual({
      status: "unusable",
      reason: `git bundle does not offer ${"0".repeat(40)} as a ref tip`,
    });
    expect(calls).toEqual([]);
  });

  test("leaves no temp file or repository behind, on success or failure", async () => {
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const before = await readdir(tempRoot);
    await verifier.verify({
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    });
    await verifier.verify({ ...withSwappedTip(bundle), key: "k" });
    expect(await readdir(tempRoot)).toEqual(before);
  });

  test("git refusing the pack yields unusable, not a throw", async () => {
    const gitRunner: GitCommandRunner = async (args) =>
      args[0] === "init"
        ? { exitCode: 0, stderr: "", stdout: "" }
        : { exitCode: 128, stderr: "fatal: pack is corrupt\n", stdout: "" };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    const verdict = await verifier.verify({
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(verdict).toEqual({
      status: "unusable",
      reason: "git fetch failed with exit code 128: fatal: pack is corrupt",
    });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a runner that cannot start git throws, and still cleans up", async () => {
    const gitRunner: GitCommandRunner = async () => {
      throw new Error("spawn git ENOENT");
    };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    await expect(
      verifier.verify({ bytes: bundle.bytes, commit: bundle.commit, key: "k" }),
    ).rejects.toThrow("spawn git ENOENT");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a repository that will not initialise is a fault, not a verdict", async () => {
    const gitRunner: GitCommandRunner = async () => ({
      exitCode: 128,
      stderr: "fatal: cannot mkdir: No space left on device\n",
      stdout: "",
    });
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    await expect(
      verifier.verify({ bytes: bundle.bytes, commit: bundle.commit, key: "k" }),
    ).rejects.toThrow("git init failed with exit code 128");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a temp root that cannot be written throws instead of rejecting the bundle", async () => {
    const verifier = createGitWorkspaceBundleVerifier({
      tempRoot: join(tempRoot, "missing"),
    });
    await expect(
      verifier.verify({ bytes: bundle.bytes, commit: bundle.commit, key: "k" }),
    ).rejects.toThrow("ENOENT");
  });

  test("git dying on the host rather than on the pack throws", async () => {
    for (const stderr of [
      "fatal: unable to write pack: No space left on device\n",
      "fatal: write error: Disk quota exceeded\n",
      "error: something this code has never seen\n",
    ]) {
      const gitRunner: GitCommandRunner = async (args) =>
        args[0] === "init"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : { exitCode: 128, stderr, stdout: "" };
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner,
        tempRoot,
      });
      await expect(
        verifier.verify({
          bytes: bundle.bytes,
          commit: bundle.commit,
          key: "k",
        }),
      ).rejects.toThrow(stderr.trim());
      expect(await readdir(tempRoot)).toEqual([]);
    }
  });

  test("a git killed by someone else's signal throws", async () => {
    const gitRunner: GitCommandRunner = async (args) =>
      args[0] === "init"
        ? { exitCode: 0, stderr: "", stdout: "" }
        : { exitCode: 128, signal: "SIGKILL", stderr: "", stdout: "" };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    await expect(
      verifier.verify({ bytes: bundle.bytes, commit: bundle.commit, key: "k" }),
    ).rejects.toThrow("git fetch was killed by SIGKILL");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("an inherited alternate object store cannot vouch for a commit the pack lacks", async () => {
    // A second repository holds a commit the bundle never carried; with the
    // host's GIT_ALTERNATE_OBJECT_DIRECTORIES pointing at it, git would find
    // the commit there and the connectivity check would pass.
    const other = await createGitBundle({ message: "elsewhere" });
    const alternate = await mkdtemp(join(tempRoot, "alternate-"));
    await defaultGitRunner(["init", "--quiet", "--bare", "."], {
      cwd: alternate,
      env: {},
    });
    await writeFile(join(alternate, "other.bundle"), other.bytes);
    const unbundle = await defaultGitRunner(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "other.bundle",
        `${other.ref}:refs/other`,
      ],
      { cwd: alternate, env: {} },
    );
    expect(unbundle.exitCode).toBe(0);
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const header = text.slice(0, text.indexOf("\n\n"));
    const bytes = new Uint8Array(bundle.bytes);
    bytes.set(
      new TextEncoder().encode(header.replace(bundle.commit, other.commit)),
      0,
    );
    const previous = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(alternate, "objects");
    try {
      const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
      const verdict = await verifier.verify({
        bytes,
        commit: other.commit,
        key: "k",
      });
      expect(verdict.status).toBe("unusable");
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      } else {
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = previous;
      }
      await rm(alternate, { force: true, recursive: true });
    }
  });

  test("a ref name git would refuse never reaches a refspec or stderr", async () => {
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const headerEnd = text.indexOf("\n\n");
    const header = text
      .slice(0, headerEnd)
      .replace(bundle.ref, "refs/heads/permission denied");
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from(header, "latin1"),
        bundle.bytes.subarray(headerEnd),
      ]),
    );
    const calls: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    const verdict = await verifier.verify({
      bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(verdict).toEqual({
      status: "unusable",
      reason:
        'git bundle ref name is not one git would accept: "refs/heads/permission denied"',
    });
    expect(calls).toEqual([]);
  });

  test("a filtered bundle is refused before git and by git alike", async () => {
    const source = await mkdtemp(join(tempRoot, "filtered-"));
    const env = {
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_AUTHOR_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
    };
    const run = async (...args: string[]) => {
      const result = await defaultGitRunner(args, { cwd: source, env });
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    await run("init", "--quiet", "--initial-branch=main", ".");
    await writeFile(join(source, "file.txt"), "x\n");
    await run("add", "file.txt");
    await run("commit", "--quiet", "-m", "c");
    const commit = await run("rev-parse", "HEAD");
    const path = join(source, "filtered.bundle");
    await run(
      "bundle",
      "create",
      "--version=3",
      path,
      "--filter=blob:none",
      "main",
    );
    const bytes = new Uint8Array(await readFile(path));
    await rm(source, { force: true, recursive: true });

    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    expect(await verifier.verify({ bytes, commit, key: "k" })).toEqual({
      status: "unusable",
      reason:
        "git bundle is filtered (filter=blob:none) and omits objects a restore needs",
    });
    // The gate exists for older or differently configured gits; this one
    // refuses the same pack on its own, which is what the gate stands in for.
    const repository = await mkdtemp(join(tempRoot, "repo-"));
    await defaultGitRunner(["init", "--quiet", "--bare", "."], {
      cwd: repository,
      env: {},
    });
    await writeFile(join(repository, "f.bundle"), bytes);
    const fetch = await defaultGitRunner(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "f.bundle",
        "refs/heads/main:refs/verify/tip",
      ],
      { cwd: repository, env: {} },
    );
    await rm(repository, { force: true, recursive: true });
    expect(fetch.exitCode).not.toBe(0);
    expect(fetch.stderr).toContain("did not send all necessary objects");
  });

  test("a bundle recorded against HEAD, as `git bundle create … HEAD` writes it, is restorable", async () => {
    const source = await mkdtemp(join(tempRoot, "head-"));
    const env = {
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_AUTHOR_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
    };
    const run = async (...args: string[]) => {
      const result = await defaultGitRunner(args, { cwd: source, env });
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    await run("init", "--quiet", "--initial-branch=main", ".");
    await writeFile(join(source, "file.txt"), "x\n");
    await run("add", "file.txt");
    await run("commit", "--quiet", "-m", "c");
    const commit = await run("rev-parse", "HEAD");
    const path = join(source, "head.bundle");
    await run("bundle", "create", path, "HEAD");
    const bytes = new Uint8Array(await readFile(path));
    await rm(source, { force: true, recursive: true });
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 80))).toContain(
      `${commit} HEAD`,
    );

    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    expect(await verifier.verify({ bytes, commit, key: "k" })).toEqual({
      status: "restorable",
    });
  });

  test("a git that outlives the timeout is killed and reported as a fault, not a verdict", async () => {
    // A stand-in git on PATH that never returns is the one way to make the
    // real runner wait; the init call still runs the real binary.
    const bin = join(tempRoot, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\n/bin/sleep 30\n", {
      mode: 0o755,
    });
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: async (args, options) =>
        args[0] === "init"
          ? defaultGitRunner(args, options)
          : defaultGitRunner(args, {
              ...options,
              env: { ...options.env, PATH: bin },
              timeoutMs: 200,
            }),
      tempRoot,
    });
    const started = Date.now();
    await expect(
      verifier.verify({ bytes: bundle.bytes, commit: bundle.commit, key: "k" }),
    ).rejects.toThrow(
      `git fetch failed with exit code ${GIT_TIMEOUT_EXIT_CODE}: git exceeded 200ms`,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await rm(bin, { force: true, recursive: true });
    expect(await readdir(tempRoot)).toEqual([]);
  });
});
