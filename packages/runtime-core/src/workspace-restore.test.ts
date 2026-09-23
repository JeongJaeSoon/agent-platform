import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restorePlanResponseSchema } from "@agent-platform/contracts";

import {
  readWorkspaceFile,
  restoreCwdRefusal,
  restoreRefusal,
  workspacePathProblem,
  workspacePathsProblem,
  writeWorkspaceFile,
} from "./workspace-restore.ts";

const bytes = new TextEncoder().encode("restored\n");

describe("workspacePathProblem", () => {
  test.each([
    "notes.md",
    "src/deep/file.ts",
    ".env.local",
    "..hidden",
    "dir/.gitignore",
    "emoji/😀.md",
    "a".repeat(255),
    // 85 three-byte syllables: 255 bytes, which is what NAME_MAX counts.
    "가".repeat(85),
  ])("accepts %p", (path) => {
    expect(workspacePathProblem(path)).toBeUndefined();
  });

  test.each([
    ["", "is empty"],
    ["/etc/passwd", "is absolute"],
    ["a\\b", "contains a backslash"],
    ["a\0b", "contains a NUL byte"],
    ["a/\uD800", "is not well-formed Unicode"],
    ["\uDC00b", "is not well-formed Unicode"],
    ["a//b", "has an empty segment"],
    ["a/", "has an empty segment"],
    ["./a", 'has a "." segment'],
    ["a/../../etc", 'has a ".." segment'],
    [".git/hooks/pre-commit", "writes into .git"],
    ["vendor/.GIT/config", "writes into .git"],
    [`dir/${"a".repeat(256)}`, "has a segment longer than 255 bytes"],
    ["가".repeat(86), "has a segment longer than 255 bytes"],
  ])("refuses %p", (path, problem) => {
    expect(workspacePathProblem(path)).toBe(problem);
  });
});

describe("workspacePathsProblem", () => {
  test("accepts distinct files in shared directories", () => {
    expect(workspacePathsProblem(["a/b", "a/c", "d"])).toBeUndefined();
  });

  test("refuses two files at one destination", () => {
    expect(workspacePathsProblem(["a/b", "a/b"])).toBe(
      "two files restore to a/b",
    );
  });

  test("refuses a file that is also another file's directory", () => {
    expect(workspacePathsProblem(["a/b/c", "a/b"])).toBe(
      "a/b is restored both as a file and as the directory of a/b/c",
    );
  });

  test("finds a conflict across names that sort between a file and its children", () => {
    // "-" and "." sort before "/", so plain sorting would put these between
    // "a" and "a/b" and hide the conflict from a neighbour check.
    expect(workspacePathsProblem(["a/b", "a-x", "a.x", "a"])).toBe(
      "a is restored both as a file and as the directory of a/b",
    );
  });

  test("stays fast on one very deep path", () => {
    // Checking every prefix of this is ~10^11 character copies.
    const deep = `${"d/".repeat(400_000)}file`;
    const started = performance.now();

    expect(workspacePathsProblem([deep, "d/other"])).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("refuses lone surrogates that would name one file on disk", () => {
    expect(workspacePathsProblem(["\uD800", "\uD801"])).toBe(
      '"\\ud800" is not well-formed Unicode',
    );
  });

  test("names the unsafe path", () => {
    expect(workspacePathsProblem(["ok", "../x"])).toBe(
      '"../x" has a ".." segment',
    );
  });
});

describe("restoreCwdRefusal", () => {
  test("accepts the provisioned root", () => {
    expect(restoreCwdRefusal("/workspace", "/workspace")).toBeUndefined();
  });

  test("refuses a manifest captured in another directory, as the plan's own refusal", () => {
    const refusal = restoreCwdRefusal("/tmp/elsewhere", "/workspace");

    expect(refusal).toEqual({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
      reason:
        "checkpoint cwd /tmp/elsewhere is not this workspace root /workspace",
    });
    expect(restorePlanResponseSchema.parse(refusal)).toEqual(
      refusal as NonNullable<typeof refusal>,
    );
  });

  test("does not resolve spellings into agreement", () => {
    expect(restoreCwdRefusal("/workspace/", "/workspace")).toMatchObject({
      code: "CHECKPOINT_UNAVAILABLE",
    });
    expect(restoreCwdRefusal("/workspace/.", "/workspace")).toMatchObject({
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });

  test.each(["workspace", "/", "/workspace/", "/a/../workspace", "/a//b"])(
    "throws on a non-canonical root %p",
    (root) => {
      expect(() => restoreCwdRefusal("/workspace", root)).toThrow(
        "canonical absolute path",
      );
    },
  );
});

describe("writeWorkspaceFile", () => {
  let scratch: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "94s-214-restore-"));
    root = join(scratch, "workspace");
    outside = join(scratch, "escape");
    await mkdir(root);
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  function write(path: string, fdDirectory?: string) {
    return writeWorkspaceFile({
      bytes,
      path,
      workspaceRoot: root,
      ...(fdDirectory === undefined ? {} : { fdDirectory }),
    });
  }

  test("refuses without a descriptor directory instead of walking paths", async () => {
    expect(await write("a/file", join(scratch, "no-procfs"))).toEqual(
      restoreRefusal(
        `restoring untracked files needs ${join(scratch, "no-procfs")} to address directories by descriptor, and it is not available here`,
      ),
    );
    expect(existsSync(join(root, "a"))).toBe(false);
  });

  test("refuses an unsafe path before touching the disk", async () => {
    expect(await write("../escape/file")).toEqual(
      restoreRefusal('untracked file "../escape/file" has a ".." segment'),
    );
    expect(existsSync(join(outside, "file"))).toBe(false);
  });

  test("refuses a name no filesystem can create, rather than throwing on it", async () => {
    expect(await write(`a/${"n".repeat(256)}`)).toMatchObject({
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });

  // procfs is the mechanism; on a machine without it every write is the
  // refusal above, which the next block would only repeat.
  describe.skipIf(!existsSync("/proc/self/fd"))("with procfs", () => {
    test("writes a nested file, creating its directories", async () => {
      expect(await write("src/deep/notes.md")).toBeUndefined();

      expect(await readFile(join(root, "src/deep/notes.md"), "utf8")).toBe(
        "restored\n",
      );
      expect((await stat(join(root, "src/deep/notes.md"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(join(root, "src/deep"))).mode & 0o777).toBe(0o700);
    });

    test("sets the execute bit only for a file captured as executable", async () => {
      expect(
        await writeWorkspaceFile({
          bytes,
          executable: true,
          path: "run.sh",
          workspaceRoot: root,
        }),
      ).toBeUndefined();
      expect(await write("plain.txt")).toBeUndefined();

      expect((await stat(join(root, "run.sh"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "plain.txt"))).mode & 0o777).toBe(0o600);
    });

    test("writes into directories the checkout already made", async () => {
      await mkdir(join(root, "src"));
      expect(await write("src/notes.md")).toBeUndefined();
      expect(await readFile(join(root, "src/notes.md"), "utf8")).toBe(
        "restored\n",
      );
    });

    test("refuses a first segment that is a symlink out of the workspace", async () => {
      await symlink(outside, join(root, "out"));

      const refusal = await write("out/file");

      expect(refusal).toEqual({
        status: "unavailable",
        code: "CHECKPOINT_UNAVAILABLE",
        reason:
          "cannot restore out/file: out is not a directory inside the workspace (a symlink or a file)",
      });
      expect(restorePlanResponseSchema.parse(refusal)).toEqual(
        refusal as NonNullable<typeof refusal>,
      );
      expect(existsSync(join(outside, "file"))).toBe(false);
    });

    test("refuses an intermediate directory that is a symlink", async () => {
      await mkdir(join(root, "a"));
      await symlink(outside, join(root, "a/b"));

      expect(await write("a/b/c/file")).toEqual(
        restoreRefusal(
          "cannot restore a/b/c/file: a/b is not a directory inside the workspace (a symlink or a file)",
        ),
      );
      expect(existsSync(join(outside, "c"))).toBe(false);
    });

    test("refuses a symlink that stays inside the workspace too", async () => {
      // Even a harmless-looking link is refused: the check is "no symlink",
      // not "no symlink that points out", which would need resolving it.
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "alias"));

      expect(await write("alias/file")).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });
      expect(existsSync(join(root, "real/file"))).toBe(false);
    });

    test("refuses a dangling symlink where a directory would be created", async () => {
      await symlink(join(outside, "made-later"), join(root, "out"));

      expect(await write("out/file")).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });
      expect(existsSync(join(outside, "made-later"))).toBe(false);
    });

    test("refuses a symlink at the destination itself", async () => {
      await symlink(join(outside, "target"), join(root, "leaf"));

      expect(await write("leaf")).toEqual(
        restoreRefusal(
          "cannot restore leaf: something is already there (EEXIST)",
        ),
      );
      expect(existsSync(join(outside, "target"))).toBe(false);
      expect((await lstat(join(root, "leaf"))).isSymbolicLink()).toBe(true);
    });

    test("refuses to overwrite a file, hard link or not", async () => {
      await writeFile(join(outside, "shared"), "outside\n");
      await link(join(outside, "shared"), join(root, "linked"));
      await writeFile(join(root, "tracked"), "tracked\n");

      expect(await write("linked")).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });
      expect(await write("tracked")).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });
      expect(await readFile(join(outside, "shared"), "utf8")).toBe("outside\n");
      expect(await readFile(join(root, "tracked"), "utf8")).toBe("tracked\n");
    });

    test("refuses a file where a directory is needed", async () => {
      await writeFile(join(root, "a"), "tracked\n");

      expect(await write("a/file")).toEqual(
        restoreRefusal(
          "cannot restore a/file: a is not a directory inside the workspace (a symlink or a file)",
        ),
      );
    });

    test("refuses a directory at the destination", async () => {
      await mkdir(join(root, "dir"));

      expect(await write("dir")).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });
    });

    test("leaves no descriptor open, written or refused", async () => {
      const open = () => readdirSync("/proc/self/fd").length;
      await mkdir(join(root, "taken"));
      await writeFile(join(root, "taken/file"), "tracked\n");
      await symlink(outside, join(root, "out"));
      const before = open();

      expect(await write("deep/a/b/c/d/e/file")).toBeUndefined();
      expect(await write("taken/file")).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });
      expect(await write("out/x/y/file")).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });

      expect(open()).toBe(before);
    });

    test("refuses a workspace root that is itself a symlink", async () => {
      const aliased = join(scratch, "aliased");
      await symlink(root, aliased);

      expect(
        await writeWorkspaceFile({
          bytes,
          path: "file",
          workspaceRoot: aliased,
        }),
      ).toEqual(restoreRefusal(`workspace root ${aliased} is not a directory`));
      expect(existsSync(join(root, "file"))).toBe(false);
    });
  });
});

describe("readWorkspaceFile", () => {
  let scratch: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "94s-246-capture-"));
    root = join(scratch, "workspace");
    outside = join(scratch, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "worker-only\n");
  });

  afterEach(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  function read(path: string, maxBytes = 1024, fdDirectory?: string) {
    return readWorkspaceFile({
      maxBytes,
      path,
      workspaceRoot: root,
      ...(fdDirectory === undefined ? {} : { fdDirectory }),
    });
  }

  test("refuses without a descriptor directory instead of walking paths", async () => {
    await writeFile(join(root, "notes.md"), "x");
    expect(await read("notes.md", 1024, join(scratch, "no-procfs"))).toEqual({
      status: "refused",
      reason: `untracked file "notes.md" cannot be read safely: ${join(scratch, "no-procfs")} does not address directories by descriptor here`,
    });
  });

  test("refuses an unsafe path before touching the disk", async () => {
    expect(await read("../outside/secret")).toEqual({
      status: "refused",
      reason: 'untracked file "../outside/secret" has a ".." segment',
    });
  });

  describe.skipIf(!existsSync("/proc/self/fd"))("with procfs", () => {
    test("reads a nested regular file", async () => {
      await mkdir(join(root, "src/deep"), { recursive: true });
      await writeFile(join(root, "src/deep/notes.md"), "captured\n");

      const result = await read("src/deep/notes.md");

      expect(result.status).toBe("read");
      if (result.status === "read") {
        expect(new TextDecoder().decode(result.bytes)).toBe("captured\n");
      }
    });

    test("says whether any execute bit is set", async () => {
      await writeFile(join(root, "tool"), "#!/bin/sh\n", { mode: 0o750 });
      await writeFile(join(root, "data"), "x", { mode: 0o644 });

      expect(await read("tool")).toMatchObject({ executable: true });
      expect(await read("data")).toMatchObject({ executable: false });
    });

    test("never follows a leaf symlink, so the worker's own files stay out", async () => {
      await symlink(join(outside, "secret"), join(root, "planted"));
      // What the engine would plant to read the capturing process itself.
      await symlink(join("/proc", "self", "status"), join(root, "self"));

      expect(await read("planted")).toMatchObject({
        status: "refused",
        reason: expect.stringMatching(/is not a regular file \(ELOOP\)/),
      });
      expect(await read("self")).toMatchObject({ status: "refused" });
    });

    test("never follows a symlinked directory on the way", async () => {
      await symlink(outside, join(root, "out"));

      expect(await read("out/secret")).toEqual({
        status: "refused",
        reason:
          'untracked file "out/secret" is not under directories inside the workspace',
      });
    });

    test("refuses a FIFO at once instead of blocking on it", async () => {
      execFileSync("mkfifo", [join(root, "pipe")]);

      expect(await read("pipe")).toEqual({
        status: "refused",
        reason: 'untracked file "pipe" is not a regular file',
      });
    });

    test("refuses a file larger than what is left of the budget", async () => {
      await writeFile(join(root, "big.bin"), new Uint8Array(2048));

      expect(await read("big.bin", 1024)).toEqual({
        status: "refused",
        reason: 'untracked file "big.bin" is 2048 bytes, over the 1024 left',
      });
    });

    test("reports a file that vanished since it was listed", async () => {
      expect(await read("gone.txt")).toEqual({
        status: "refused",
        reason: 'untracked file "gone.txt" is gone',
      });
    });
  });
});
