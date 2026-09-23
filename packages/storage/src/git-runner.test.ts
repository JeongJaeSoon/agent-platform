import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultGitRunner,
  GIT_OUTPUT_LIMIT_BYTES,
  type GitResourceLimits,
} from "./git-runner.ts";

const linux = process.platform === "linux";

/** Roomy enough that only the one limit a test tightens can bite. */
const roomy: GitResourceLimits = {
  cpuSeconds: 60,
  fileSizeBytes: 64 * 1024 * 1024,
  memoryBytes: 512 * 1024 * 1024,
};

let bin: string;

/** A stand-in `git` on PATH: the script body decides what it does. */
async function fakeGit(script: string): Promise<Record<string, string>> {
  await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { PATH: bin };
}

/**
 * Whether `pid` still runs. A killed helper whose parent died first is
 * reparented to PID 1, and where that is this test runner (bun as a
 * container's PID 1) nobody reaps it: it is dead, just still listed.
 */
async function running(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat !== "" && !/^\d+ \(.*\) Z /.test(stat);
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

  test("a git that fails leaves its helper to the timeout, not to a kill on exit", async () => {
    // Node reports the exit after reaping git, when its pid may already be
    // someone else's; only the timeout, which fires while the helper still
    // holds the group, may signal it.
    const pidFile = join(bin, "helper.pid");
    const env = await fakeGit(
      `/bin/sleep 30 & echo $! > ${pidFile}; echo failed >&2; exit 1`,
    );
    const started = Date.now();
    const result = await defaultGitRunner(["x"], { env, timeoutMs: 500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(result.exitCode).toBe(1);
    const helper = Number((await readFile(pidFile, "utf8")).trim());
    await Bun.sleep(100);
    expect(await running(helper)).toBe(false);
  });

  test("refuses limits that are not positive integers before starting git", async () => {
    const env = await fakeGit("echo ran");
    for (const limits of [
      { ...roomy, memoryBytes: 0 },
      { ...roomy, fileSizeBytes: 1.5 },
      { ...roomy, cpuSeconds: Number.POSITIVE_INFINITY },
    ]) {
      await expect(defaultGitRunner(["x"], { env, limits })).rejects.toThrow(
        RangeError,
      );
    }
  });

  test.skipIf(!linux)(
    "a file past fileSizeBytes kills git with SIGXFSZ",
    async () => {
      const out = join(bin, "written");
      const env = await fakeGit(
        `exec /usr/bin/head -c ${4 * 1024 * 1024} /dev/zero > ${out}`,
      );
      const result = await defaultGitRunner(["x"], {
        env,
        limits: { ...roomy, fileSizeBytes: 1024 * 1024 },
      });
      expect(result.signal).toBe("SIGXFSZ");
      expect((await stat(out)).size).toBe(1024 * 1024);
    },
  );

  test.skipIf(!linux)(
    "a git past cpuSeconds is killed",
    async () => {
      const env = await fakeGit("exec /bin/sh -c 'while :; do :; done'");
      const result = await defaultGitRunner(["x"], {
        env,
        limits: { ...roomy, cpuSeconds: 1 },
        timeoutMs: 20_000,
      });
      // Soft and hard limit are the same, so SIGXCPU may be followed by
      // SIGKILL before the shell ever handles the first.
      expect(["SIGXCPU", "SIGKILL"]).toContain(result.signal as string);
      expect(result.timedOut).toBeUndefined();
    },
    30_000,
  );

  test.skipIf(linux)(
    "where limits cannot be enforced git still runs, and says so once",
    async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const env = await fakeGit("echo ran");
        const first = await defaultGitRunner(["x"], { env, limits: roomy });
        const second = await defaultGitRunner(["x"], { env, limits: roomy });
        expect(first.stdout).toBe("ran\n");
        expect(second.stdout).toBe("ran\n");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain("not enforced");
      } finally {
        warn.mockRestore();
      }
    },
  );
});
