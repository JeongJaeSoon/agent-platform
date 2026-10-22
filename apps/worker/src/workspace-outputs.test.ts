import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredOutput } from "@werft-ai/runtime-core";

import { indexOutputs, type OutputLimits } from "./workspace-outputs.ts";

const procfs = existsSync("/proc/self/fd");

let scratch: string;
let workspace: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-777-outputs-"));
  workspace = join(scratch, "workspace");
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stores by digest, as the publish does, and records what it was handed. */
function recording(limits?: OutputLimits) {
  const stored: string[] = [];
  return {
    stored,
    index: () =>
      indexOutputs({
        workspaceRoot: workspace,
        ...(limits === undefined ? {} : { limits }),
        store: async ({ bytes, path }): Promise<StoredOutput> => {
          stored.push(path);
          const digest = sha256(bytes);
          return {
            bytes: bytes.byteLength,
            key: `outputs/${digest}`,
            path,
            sha256: digest,
          };
        },
      }),
  };
}

describe.skipIf(!procfs)("indexOutputs", () => {
  test("lists regular files under out/, nested ones too, with their size and digest", async () => {
    await mkdir(join(workspace, "out", "tables"), { recursive: true });
    await writeFile(join(workspace, "out", "report.md"), "# 보고서\n");
    await writeFile(join(workspace, "out", "tables", "q3.csv"), "a,b\n1,2\n");
    await writeFile(join(workspace, "notes.md"), "not an output\n");

    const { index } = recording();
    const result = await index();

    expect(result).toEqual({
      dropped: 0,
      outputs: [
        {
          bytes: Buffer.byteLength("# 보고서\n"),
          key: `outputs/${sha256("# 보고서\n")}`,
          path: "out/report.md",
          sha256: sha256("# 보고서\n"),
        },
        {
          bytes: 8,
          key: `outputs/${sha256("a,b\n1,2\n")}`,
          path: "out/tables/q3.csv",
          sha256: sha256("a,b\n1,2\n"),
        },
      ],
    });
  });

  test("leaves out symlinks, whether to a file inside, a file outside or a directory above", async () => {
    await mkdir(join(workspace, "out"));
    await writeFile(join(scratch, "secret.txt"), "worker credentials\n");
    await writeFile(join(workspace, "out", "report.md"), "report\n");
    await symlink("report.md", join(workspace, "out", "latest.md"));
    await symlink("../../secret.txt", join(workspace, "out", "escape.txt"));
    await symlink("..", join(workspace, "out", "up"));
    await symlink("/proc/self/environ", join(workspace, "out", "environ"));

    const { index, stored } = recording();
    const result = await index();

    expect(result.outputs.map((output) => output.path)).toEqual([
      "out/report.md",
    ]);
    expect(stored).toEqual(["out/report.md"]);
  });

  test("lists nothing when out itself is a symlink", async () => {
    await mkdir(join(scratch, "elsewhere"));
    await writeFile(join(scratch, "elsewhere", "secret.txt"), "secret\n");
    await symlink(join(scratch, "elsewhere"), join(workspace, "out"));

    expect((await recording().index()).outputs).toEqual([]);
  });

  test("lists nothing, and refuses nothing, when there is no out/", async () => {
    expect(await recording().index()).toEqual({ dropped: 0, outputs: [] });
  });

  test("skips a FIFO and a name the manifest could not carry", async () => {
    await mkdir(join(workspace, "out", ".git"), { recursive: true });
    await writeFile(join(workspace, "out", ".git", "config"), "x\n");
    await writeFile(join(workspace, "out", "a\\b.txt"), "x\n");
    await writeFile(join(workspace, "out", "ok.txt"), "x\n");
    Bun.spawnSync(["mkfifo", join(workspace, "out", "pipe")]);

    expect(
      (await recording().index()).outputs.map((output) => output.path),
    ).toEqual(["out/ok.txt"]);
  });

  test("lists a file over the file limit, or past the total, as too large without reading it", async () => {
    await mkdir(join(workspace, "out"));
    await writeFile(join(workspace, "out", "a.txt"), "1234");
    await writeFile(join(workspace, "out", "b.bin"), "123456789");
    await writeFile(join(workspace, "out", "c.txt"), "12345");
    await writeFile(join(workspace, "out", "d.txt"), "12");

    const { index, stored } = recording({
      maxFileBytes: 8,
      maxTotalBytes: 8,
      maxFiles: 10,
    });
    const result = await index();

    expect(result.outputs).toEqual([
      expect.objectContaining({ path: "out/a.txt", bytes: 4 }),
      { bytes: 9, omitted: "too_large", path: "out/b.bin" },
      { bytes: 5, omitted: "too_large", path: "out/c.txt" },
      expect.objectContaining({ path: "out/d.txt", bytes: 2 }),
    ]);
    expect(stored).toEqual(["out/a.txt", "out/d.txt"]);
  });

  test("leaves out the files past the count limit and says how many", async () => {
    await mkdir(join(workspace, "out"));
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(workspace, "out", name), name);
    }

    const result = await recording({
      maxFileBytes: 8,
      maxTotalBytes: 8,
      maxFiles: 2,
    }).index();

    expect(result.outputs.map((output) => output.path)).toEqual([
      "out/a",
      "out/b",
    ]);
    expect(result.dropped).toBe(1);
  });

  test("without a descriptor directory, reads nothing and says why", async () => {
    await mkdir(join(workspace, "out"));
    await writeFile(join(workspace, "out", "report.md"), "report\n");
    const empty = join(scratch, "no-fd");
    await mkdir(empty);

    const result = await indexOutputs({
      fdDirectory: empty,
      store: () => {
        throw new Error("nothing should be stored");
      },
      workspaceRoot: workspace,
    });

    expect(result.outputs).toEqual([]);
    expect(result.refused).toMatch(/does not address directories/);
  });
});
