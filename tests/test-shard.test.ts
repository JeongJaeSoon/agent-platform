import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discover, split, testRoots } from "../.github/scripts/test-shard.ts";

const repo = join(import.meta.dir, "..");
const script = join(repo, ".github", "scripts", "test-shard.ts");

async function shard(args: string[]) {
  const process = Bun.spawn(["bun", script, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, lines: stdout.split("\n").filter(Boolean), stderr };
}

describe("test-shard.ts", () => {
  test("reads the roots from the test script it stands in for", async () => {
    const pkg = await Bun.file(join(repo, "package.json")).json();

    expect(testRoots(pkg.scripts.test)).toEqual(["tests", "packages", "apps"]);
    expect(() => testRoots("bun test --timeout 5000 tests")).toThrow(
      /no longer `bun test <dirs>`/,
    );
  });

  test("discovers what bun test would, and nothing under node_modules or hidden directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-shard-"));
    try {
      for (const path of [
        "a/one.test.ts",
        "a/two_test.tsx",
        "a/three.spec.js",
        "a/four_spec.mts",
        "a/nested/five.test.cjs",
        "a/helper.ts",
        "a/server.integration.ts",
        "a/node_modules/dep/x.test.ts",
        "a/.cache/y.test.ts",
        "b/six.test.ts",
        "c/seven.test.ts",
      ]) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), "");
      }

      expect(discover(root, ["a", "b"])).toEqual([
        "a/four_spec.mts",
        "a/nested/five.test.cjs",
        "a/one.test.ts",
        "a/three.spec.js",
        "a/two_test.tsx",
        "b/six.test.ts",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("puts every file in exactly one shard, heaviest first onto the lightest", () => {
    const files = [
      { path: "a", weight: 10 },
      { path: "b", weight: 7 },
      { path: "c", weight: 5 },
      { path: "d", weight: 4 },
      { path: "e", weight: 1 },
    ];

    expect(split(files, 2)).toEqual([
      ["a", "d"],
      ["b", "c", "e"],
    ]);
    expect(split(files, 1)).toEqual([["a", "b", "c", "d", "e"]]);
  });

  test("refuses a shard with no files, which bun test would read as the whole suite", () => {
    expect(() => split([{ path: "a", weight: 1 }], 2)).toThrow(
      "shard 2/2 has no files",
    );
  });

  test("the shards of this repo cover its suite exactly once", async () => {
    const total = 3;
    const outcomes = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        shard([String(i + 1), String(total)]),
      ),
    );
    const all = outcomes.flatMap((outcome) => outcome.lines);
    const suite = discover(repo, ["tests", "packages", "apps"]).map(
      (path) => `./${path}`,
    );

    for (const outcome of outcomes) expect(outcome.exitCode).toBe(0);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(suite);
    expect(all).toContain("./tests/test-shard.test.ts");
  });

  test("rejects an index outside the shard count", async () => {
    for (const args of [["0", "4"], ["5", "4"], ["1"], ["x", "4"]]) {
      const outcome = await shard(args);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toContain("usage:");
    }
  });
});
