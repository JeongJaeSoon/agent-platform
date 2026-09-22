import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceDescriptor } from "@agent-platform/contracts";

import { GitWorkspace } from "./workspace.ts";

let scratch: string;
let origin: string;
let root: string;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function descriptor(url = origin, branch = "main"): WorkspaceDescriptor {
  return { repository: { id: "sample-app", url, branch } };
}

function prepare(workspace: WorkspaceDescriptor, signal?: AbortSignal) {
  return new GitWorkspace(root).prepare({
    descriptor: workspace,
    restore: null,
    signal: signal ?? new AbortController().signal,
  });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-122-ws-"));
  origin = join(scratch, "origin.git");
  root = join(scratch, "workspace");
  git(["init", "--quiet", "--bare", "--initial-branch=main", origin], scratch);
  const seed = join(scratch, "seed");
  git(["clone", "--quiet", origin, seed], scratch);
  await writeFile(join(seed, "README.md"), "seed\n");
  git(["add", "README.md"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", "origin", "HEAD:main"], seed);
  await mkdir(root);
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("GitWorkspace", () => {
  test("clones the session's branch into an empty mount", async () => {
    expect(await prepare(descriptor())).toBe("clone");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], root)).toBe("main");
    expect(await Bun.file(join(root, "README.md")).text()).toBe("seed\n");
  });

  test("reuses a sound checkout of the same origin and keeps its work", async () => {
    await prepare(descriptor());
    await writeFile(join(root, "notes.txt"), "left by the last attempt\n");

    expect(await prepare(descriptor())).toBe("reuse");
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe(
      "left by the last attempt\n",
    );
  });

  test("starts over from this session's shallow checkout when it holds nothing", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);

    expect(await prepare(descriptor(`file://${origin}`))).toBe("recreate");
    expect(git(["rev-parse", "--is-shallow-repository"], root)).toBe("false");
  });

  test("refuses to delete an unsound checkout that holds work", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);
    await writeFile(join(root, "draft.txt"), "only here\n");

    await expect(prepare(descriptor(`file://${origin}`))).rejects.toThrow(
      "holds work that exists nowhere else",
    );
    expect(await Bun.file(join(root, "draft.txt")).text()).toBe("only here\n");
  });

  test("refuses files that are not a checkout, and leaves them alone", async () => {
    await writeFile(join(root, "stray.txt"), "?\n");

    await expect(prepare(descriptor())).rejects.toThrow("not a git checkout");
    expect(await readdir(root)).toEqual(["stray.txt"]);
  });

  test("refuses a checkout of another repository", async () => {
    await prepare(descriptor());

    await expect(
      prepare(descriptor("https://git.example.test/other.git")),
    ).rejects.toThrow("another repository");
  });

  test("leaves a committed checkpoint to the restorer", async () => {
    await writeFile(join(root, "stray.txt"), "?\n");

    expect(
      await new GitWorkspace(root).prepare({
        descriptor: descriptor(),
        restore: {
          revision: 3,
          manifest_ref: "sessions/x/manifest-3.json",
          manifest_sha256: "a".repeat(64),
        },
        signal: new AbortController().signal,
      }),
    ).toBe("restore");
    expect(await readdir(root)).toEqual(["stray.txt"]);
  });

  test("never puts the repository credential in a failure", async () => {
    // Nothing listens on the discard port, so the clone fails at once.
    const url = "http://someone:hunter2@127.0.0.1:9/private.git";

    const failure = await prepare(descriptor(url)).catch(
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("git clone failed");
    expect((failure as Error).message).not.toContain("hunter2");
  });

  test("stops at once when the worker is told to stop", async () => {
    const stop = new AbortController();
    stop.abort();

    await expect(prepare(descriptor(), stop.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});
