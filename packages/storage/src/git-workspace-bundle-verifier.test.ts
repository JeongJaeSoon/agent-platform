import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
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
  DEFAULT_GIT_VERIFY_TIMEOUT_MS,
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  defaultGitRunner,
  GIT_TIMEOUT_EXIT_CODE,
  type GitCommandOptions,
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
      "fatal: cannot fork() for git index-pack: Resource temporarily unavailable\n",
      "error: unable to open object pack directory: repo.git/objects/pack: Permission denied\nfatal: index-pack failed\n",
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
      ).rejects.toThrow(stderr.trim().split("\n")[0] as string);
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
        "-c",
        "maintenance.auto=false",
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
    for (const ref of [
      "refs/heads/permission denied",
      "refs/heads/main.",
      "refs/heads/main.lock",
      "refs/heads/.hidden",
      "refs/heads/a..b",
      "refs/heads/a@{b",
      "refs/heads/a~b",
      "refs/heads/a^b",
      "refs/heads/a:b",
      "refs/heads/a?b",
      "refs/heads/a*b",
      "refs/heads/a[b",
      "refs/heads/a\\b",
      "refs/heads/a\u0007b",
      "refs/heads//b",
      "refs/heads/",
      "main",
    ]) {
      const text = new TextDecoder("latin1").decode(bundle.bytes);
      const headerEnd = text.indexOf("\n\n");
      const header = text.slice(0, headerEnd).replace(bundle.ref, ref);
      const bytes = new Uint8Array(
        Buffer.concat([
          Buffer.from(header, "utf8"),
          bundle.bytes.subarray(headerEnd),
        ]),
      );
      const calls: string[][] = [];
      const gitRunner: GitCommandRunner = async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner,
        tempRoot,
      });
      const verdict = await verifier.verify({
        bytes,
        commit: bundle.commit,
        key: "k",
      });
      expect(verdict).toEqual({
        status: "unusable",
        reason: `git bundle ref name is not one git would accept: ${JSON.stringify(ref)}`,
      });
      expect(calls).toEqual([]);
    }
  });

  test("ref names git bundles actually write pass the gate", async () => {
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature/x-1.2_y",
      "refs/heads/feature+foo",
      "refs/heads/기능/한글",
      "refs/heads/a@b#c=d,e;f",
      "refs/tags/v1.0.0",
      "HEAD",
    ]) {
      const text = new TextDecoder("latin1").decode(bundle.bytes);
      const headerEnd = text.indexOf("\n\n");
      const header = text.slice(0, headerEnd).replace(bundle.ref, ref);
      const bytes = new Uint8Array(
        Buffer.concat([
          Buffer.from(header, "utf8"),
          bundle.bytes.subarray(headerEnd),
        ]),
      );
      const calls: string[][] = [];
      const gitRunner: GitCommandRunner = async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner,
        tempRoot,
      });
      await verifier.verify({ bytes, commit: bundle.commit, key: "k" });
      expect(calls.map((args) => args[0])).toEqual(["init", "-c", "rev-list"]);
    }
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
        "-c",
        "maintenance.auto=false",
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

  test("a pack padded after its objects, with the trailer recomputed, is refused by git and reported as unusable", async () => {
    // Passes every byte-level check: the header is intact and the trailing
    // sha1 covers the padded body. Only index-pack notices.
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const packOffset = text.indexOf("\n\n") + 2;
    const body = Buffer.concat([
      bundle.bytes.subarray(packOffset, bundle.bytes.byteLength - 20),
      Buffer.from("JUNKJUNK"),
    ]);
    const bytes = new Uint8Array(
      Buffer.concat([
        bundle.bytes.subarray(0, packOffset),
        body,
        createHash("sha1").update(body).digest(),
      ]),
    );
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const verdict = await verifier.verify({
      bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(verdict.status).toBe("unusable");
    if (verdict.status === "unusable") {
      expect(verdict.reason).toContain("git fetch failed");
    }
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a pack whose object count was raised, with the trailer recomputed, is never restorable", async () => {
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const packOffset = text.indexOf("\n\n") + 2;
    const body = Buffer.from(
      bundle.bytes.subarray(packOffset, bundle.bytes.byteLength - 20),
    );
    body.writeUInt32BE(body.readUInt32BE(8) + 1, 8);
    const bytes = new Uint8Array(
      Buffer.concat([
        bundle.bytes.subarray(0, packOffset),
        body,
        createHash("sha1").update(body).digest(),
      ]),
    );
    // index-pack reads the recomputed trailer as the missing object, so what
    // it says depends on those twenty bytes: usually a premature end of the
    // pack (unusable), but git 2.47 on Linux sometimes aborts on
    // `BUG: git-zlib.c:58: total_in mismatch` instead, which reaches us as
    // "index-pack died of signal 6" — a crash, so a retryable throw.
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const outcome = await verifier
      .verify({ bytes, commit: bundle.commit, key: "k" })
      .then(
        (verdict) => verdict.status,
        (error: Error) => error.message,
      );
    expect(outcome).not.toBe("restorable");
    if (outcome !== "unusable") expect(outcome).toContain("died of signal");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a pack declaring more objects than the ceiling is refused before git", async () => {
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const packOffset = text.indexOf("\n\n") + 2;
    const body = Buffer.from(
      bundle.bytes.subarray(packOffset, bundle.bytes.byteLength - 20),
    );
    body.writeUInt32BE(5_000_000, 8);
    const bytes = new Uint8Array(
      Buffer.concat([
        bundle.bytes.subarray(0, packOffset),
        body,
        createHash("sha1").update(body).digest(),
      ]),
    );
    const calls: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    expect(
      await verifier.verify({ bytes, commit: bundle.commit, key: "k" }),
    ).toEqual({
      status: "unusable",
      reason:
        "git bundle declares 5000000 objects, over the 1000000 the control plane will index",
    });
    expect(calls).toEqual([]);
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

  test("every git call runs under the limits, sized from the bundle", async () => {
    const calls: { args: readonly string[]; options: GitCommandOptions }[] = [];
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: async (args, options) => {
        calls.push({ args, options });
        return defaultGitRunner(args, options);
      },
      tempRoot,
    });
    expect(
      await verifier.verify({
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).toEqual({ status: "restorable" });
    expect(calls.map((call) => call.args[0])).toEqual([
      "init",
      "-c",
      "rev-list",
    ]);
    for (const { options } of calls) {
      expect(options.limits).toEqual({
        cpuSeconds: DEFAULT_GIT_VERIFY_TIMEOUT_MS / 1000,
        // Three objects: the index outweighs a bundle this small.
        fileSizeBytes: 1024 + 3 * 40 + 1024 * 1024,
        memoryBytes: DEFAULT_MAX_GIT_MEMORY_BYTES,
      });
      const { TMPDIR } = options.env;
      expect(TMPDIR?.startsWith(join(tempRoot, "bundle-verify-"))).toBe(true);
    }
    expect(calls[1]?.args.join(" ")).toContain("-c pack.threads=1");
  });

  test("a git or helper stopped by a resource limit throws, never unusable", async () => {
    // What git 2.47 on Linux prints when prlimit's caps bite: RLIMIT_AS as
    // index-pack's malloc failure, RLIMIT_FSIZE and RLIMIT_CPU as its death
    // by SIGXFSZ (25) or SIGKILL (9) reported by fetch.
    for (const stderr of [
      "fatal: Out of memory, malloc failed (tried to allocate 503316546 bytes)\nerror: index-pack died\n",
      "error: index-pack died of signal 25\nerror: index-pack died\n",
      "error: index-pack died of signal 9\nerror: index-pack died\n",
    ]) {
      const gitRunner: GitCommandRunner = async (args) =>
        args[0] === "init"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : { exitCode: 1, stderr, stdout: "" };
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
      ).rejects.toThrow(stderr.trim().split("\n")[0] as string);
      expect(await readdir(tempRoot)).toEqual([]);
    }
    // The limit hitting git itself rather than a helper.
    for (const signal of ["SIGXFSZ", "SIGXCPU", "SIGKILL"]) {
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner: async (args) =>
          args[0] === "init"
            ? { exitCode: 0, stderr: "", stdout: "" }
            : { exitCode: 128, signal, stderr: "", stdout: "" },
        tempRoot,
      });
      await expect(
        verifier.verify({
          bytes: bundle.bytes,
          commit: bundle.commit,
          key: "k",
        }),
      ).rejects.toThrow(`git fetch was killed by ${signal}`);
    }
  });

  test("output cut short is not classified, even when what survived reads as a refusal", async () => {
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: async (args) =>
        args[0] === "init"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : {
              exitCode: 128,
              stderr: "error: object 1234: fsck error in packed object\n",
              stdout: "",
              truncated: true,
            },
      tempRoot,
    });
    await expect(
      verifier.verify({ bytes: bundle.bytes, commit: bundle.commit, key: "k" }),
    ).rejects.toThrow("output cut short");
  });

  test.skipIf(process.platform !== "linux")(
    "on Linux an object bigger than the memory cap kills index-pack and throws",
    async () => {
      // Incompressible, so the bundle stays as big as the object and
      // index-pack has to hold all of it at once.
      const big = await createGitBundle({
        contents: new Uint8Array(randomBytes(16 * 1024 * 1024)),
      });
      const capped = createGitWorkspaceBundleVerifier({
        maxGitMemoryBytes: 16 * 1024 * 1024,
        tempRoot,
      });
      await expect(
        capped.verify({ bytes: big.bytes, commit: big.commit, key: "k" }),
      ).rejects.toThrow("Out of memory");
      expect(await readdir(tempRoot)).toEqual([]);
      // Same bundle, default cap: the limit, not the bundle, was the cause.
      const roomy = createGitWorkspaceBundleVerifier({ tempRoot });
      expect(
        await roomy.verify({ bytes: big.bytes, commit: big.commit, key: "k" }),
      ).toEqual({ status: "restorable" });
    },
    60_000,
  );
});
