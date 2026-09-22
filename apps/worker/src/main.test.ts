import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exitCodeFor, verifyWorkspace } from "./main.ts";

describe("exitCodeFor", () => {
  test.each([
    ["drained", 0],
    ["idle", 0],
    ["unclaimed", 0],
    ["lease_lost", 1],
    ["failed", 1],
  ] as const)("reports %s as exit code %d", (outcome, code) => {
    expect(exitCodeFor({ outcome, reason: "because", turns: [] })).toBe(code);
  });
});

describe("verifyWorkspace", () => {
  test("accepts a checkout the execution backend mounted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "94s-122-"));
    try {
      await mkdir(join(directory, ".git"));
      await expect(verifyWorkspace(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses to claim a session it has nowhere to run", async () => {
    await expect(
      verifyWorkspace(join(tmpdir(), "94s-122-does-not-exist")),
    ).rejects.toThrow("WORKER_WORKSPACE_DIR");
  });

  test("refuses an empty volume nobody provisioned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "94s-122-"));
    try {
      await expect(verifyWorkspace(directory)).rejects.toThrow(
        "not a git checkout",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses a path that is not a directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "94s-122-"));
    const file = join(directory, "workspace");
    try {
      await writeFile(file, "not a directory");
      await expect(verifyWorkspace(file)).rejects.toThrow("does not exist");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
