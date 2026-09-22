import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultGitRunner, GIT_OUTPUT_LIMIT_BYTES } from "./git-runner.ts";

let bin: string;

/** A stand-in `git` on PATH: the script body decides what it does. */
async function fakeGit(script: string): Promise<Record<string, string>> {
  await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { PATH: bin };
}

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "git-runner-"));
  await mkdir(bin, { recursive: true });
});

afterAll(async () => {
  await rm(bin, { force: true, recursive: true });
});

describe("defaultGitRunner", () => {
  test("keeps a bounded prefix of each stream and says when it cut", async () => {
    const env = await fakeGit(
      `/usr/bin/head -c ${GIT_OUTPUT_LIMIT_BYTES * 4} /dev/zero | /usr/bin/tr '\\0' e >&2; echo out; exit 3`,
    );
    const result = await defaultGitRunner(["spew"], { env });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toHaveLength(GIT_OUTPUT_LIMIT_BYTES);
    expect(result.truncated).toBe(true);
  });

  test("reports output under the limit whole, without a truncation mark", async () => {
    const env = await fakeGit("echo hello; echo oops >&2");
    const result = await defaultGitRunner(["x"], { env });
    expect(result).toEqual({
      exitCode: 0,
      stderr: "oops\n",
      stdout: "hello\n",
    });
  });

  test("strips inherited GIT_* only when asked", async () => {
    const env = await fakeGit('echo "dir=$GIT_DIR"');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = "/elsewhere";
    try {
      const inherited = await defaultGitRunner(["x"], { env });
      expect(inherited.stdout).toBe("dir=/elsewhere\n");
      const cleared = await defaultGitRunner(["x"], {
        clearGitEnvironment: true,
        env,
      });
      expect(cleared.stdout).toBe("dir=\n");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});
