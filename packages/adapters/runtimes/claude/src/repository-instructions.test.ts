import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPOSITORY_CLAUDE_MD_MAX_BYTES,
  readRepositoryClaudeMd,
  systemPromptAppend,
} from "./repository-instructions.ts";

let scratch: string;
let workspace: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-258-"));
  workspace = join(scratch, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

describe("readRepositoryClaudeMd", () => {
  test("a repository without one has no instructions", () => {
    expect(readRepositoryClaudeMd(workspace)).toBeUndefined();
  });

  test("reads the root file as it is", async () => {
    await writeFile(join(workspace, "CLAUDE.md"), "Run bun test.\n");
    expect(readRepositoryClaudeMd(workspace)).toBe("Run bun test.\n");
  });

  test("follows a link that stays inside the checkout", async () => {
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "AGENTS.md"), "shared rules");
    await symlink("docs/AGENTS.md", join(workspace, "CLAUDE.md"));
    expect(readRepositoryClaudeMd(workspace)).toBe("shared rules");
  });

  test("a name that merely starts with two dots is still inside", async () => {
    await mkdir(join(workspace, "..shared"));
    await writeFile(join(workspace, "..shared", "CLAUDE.md"), "dotted");
    await symlink("..shared/CLAUDE.md", join(workspace, "CLAUDE.md"));
    expect(readRepositoryClaudeMd(workspace)).toBe("dotted");
  });

  test("a link to nothing is no instructions", async () => {
    await symlink("missing.md", join(workspace, "CLAUDE.md"));
    expect(readRepositoryClaudeMd(workspace)).toBeUndefined();
  });

  test("refuses a link that leaves the checkout", async () => {
    await writeFile(join(scratch, "outside"), "WORKER_SECRET=1");
    await symlink("../outside", join(workspace, "CLAUDE.md"));
    expect(() => readRepositoryClaudeMd(workspace)).toThrow(
      "Repository CLAUDE.md resolves outside the workspace",
    );
    await rm(join(workspace, "CLAUDE.md"));
    await symlink(join(scratch, "outside"), join(workspace, "CLAUDE.md"));
    expect(() => readRepositoryClaudeMd(workspace)).toThrow(
      "Repository CLAUDE.md resolves outside the workspace",
    );
  });

  test("the checkout directory reached through a link is still the checkout", async () => {
    await writeFile(join(workspace, "CLAUDE.md"), "via link");
    await symlink(workspace, join(scratch, "linked"));
    expect(readRepositoryClaudeMd(join(scratch, "linked"))).toBe("via link");
  });

  test("refuses anything but a regular file, without blocking on a FIFO", async () => {
    await mkdir(join(workspace, "CLAUDE.md"));
    expect(() => readRepositoryClaudeMd(workspace)).toThrow(/regular file/);
    await rm(join(workspace, "CLAUDE.md"), { recursive: true });
    expect(spawnSync("mkfifo", [join(workspace, "CLAUDE.md")]).status).toBe(0);
    expect(() => readRepositoryClaudeMd(workspace)).toThrow(/regular file/);
  });

  test("refuses a file past the cap instead of handing over part of it", async () => {
    await writeFile(
      join(workspace, "CLAUDE.md"),
      "a".repeat(REPOSITORY_CLAUDE_MD_MAX_BYTES + 1),
    );
    expect(() => readRepositoryClaudeMd(workspace)).toThrow(
      `Repository CLAUDE.md is larger than ${REPOSITORY_CLAUDE_MD_MAX_BYTES} bytes`,
    );
  });

  test("a file exactly at the cap is whole", async () => {
    const whole = "b".repeat(REPOSITORY_CLAUDE_MD_MAX_BYTES);
    await writeFile(join(workspace, "CLAUDE.md"), whole);
    expect(readRepositoryClaudeMd(workspace)).toBe(whole);
  });
});

describe("systemPromptAppend", () => {
  test("leaves the file alone unless the config lets it in", async () => {
    await writeFile(join(workspace, "CLAUDE.md"), "repo rules");
    expect(systemPromptAppend({ cwd: workspace })).toBeUndefined();
    expect(
      systemPromptAppend({ appendSystemPrompt: "platform", cwd: workspace }),
    ).toBe("platform");
  });

  test("puts the caller's addition first and the repository's under its heading", async () => {
    await writeFile(join(workspace, "CLAUDE.md"), "repo rules");
    expect(
      systemPromptAppend({
        appendSystemPrompt: "platform",
        cwd: workspace,
        repositoryClaudeMd: true,
      }),
    ).toBe(
      "platform\n\nContents of CLAUDE.md at the root of the repository you are working in (project instructions checked into it):\n\nrepo rules",
    );
  });

  test("an empty or missing file adds nothing", async () => {
    expect(
      systemPromptAppend({ cwd: workspace, repositoryClaudeMd: true }),
    ).toBeUndefined();
    await writeFile(join(workspace, "CLAUDE.md"), "  \n");
    expect(
      systemPromptAppend({ cwd: workspace, repositoryClaudeMd: true }),
    ).toBeUndefined();
  });
});
