import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoAncestorInstructions,
  createIsolatedWorkspace,
  findAncestorInstructions,
  isolatedSdkEnv,
} from "./workspace.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("isolated workspace fixture", () => {
  test("creates workspace/.claude and a separate home under one temp root", async () => {
    const ws = await createIsolatedWorkspace({ prefix: "testkit-spec-" });
    cleanups.push(ws.dispose);

    expect(ws.workspace).toBe(join(ws.root, "workspace"));
    expect(ws.home).toBe(join(ws.root, "home"));
    expect(ws.claudeConfigDir).toBe(ws.home);
    expect((await stat(join(ws.workspace, ".claude"))).isDirectory()).toBe(
      true,
    );
    expect((await stat(ws.home)).isDirectory()).toBe(true);

    await ws.dispose();
    await expect(stat(ws.root)).rejects.toThrow();
  });

  test("refuses a workspace whose parent tree carries CLAUDE.md", async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "testkit-leak-")),
    );
    cleanups.push(() => rm(parent, { force: true, recursive: true }));
    await writeFile(join(parent, "CLAUDE.md"), "PARENT_INSTRUCTIONS");
    await mkdir(join(parent, ".claude"), { recursive: true });
    await writeFile(join(parent, ".claude", "CLAUDE.md"), "PARENT_RULES");

    await expect(createIsolatedWorkspace({ parent })).rejects.toThrow(
      join(parent, "CLAUDE.md"),
    );
    const leaks = await findAncestorInstructions(
      join(parent, "x", "workspace"),
    );
    expect(leaks).toEqual([
      join(parent, "CLAUDE.md"),
      join(parent, ".claude", "CLAUDE.md"),
    ]);
    await expect(
      assertNoAncestorInstructions(join(parent, "x", "workspace")),
    ).rejects.toThrow("tenant-private");
  });

  test("builds a subprocess environment that points HOME and config at the fixture", async () => {
    const ws = await createIsolatedWorkspace();
    cleanups.push(ws.dispose);
    const env = isolatedSdkEnv(ws, { baseUrl: "http://127.0.0.1:1" });

    expect(env.HOME).toBe(ws.home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(ws.home);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
    expect(env.ANTHROPIC_API_KEY).toBe("placeholder-local");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CONFIG_DIR",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
    ]);
  });
});
