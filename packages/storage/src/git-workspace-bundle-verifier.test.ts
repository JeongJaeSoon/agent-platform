import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

  test("a git that outlives the timeout is killed and reported as unusable", async () => {
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
    const verdict = await verifier.verify({
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(verdict).toEqual({
      status: "unusable",
      reason: `git fetch failed with exit code ${GIT_TIMEOUT_EXIT_CODE}: git exceeded 200ms`,
    });
    await rm(bin, { force: true, recursive: true });
    expect(await readdir(tempRoot)).toEqual([]);
  });
});
