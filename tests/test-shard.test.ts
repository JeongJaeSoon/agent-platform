import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discover, split, testFilters } from "../.github/scripts/test-shard.ts";

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
  test("reads the filters from the test script it stands in for", async () => {
    const pkg = await Bun.file(join(repo, "package.json")).json();

    expect(testFilters(pkg.scripts.test)).toEqual([
      "tests",
      "packages",
      "apps",
    ]);
    expect(() => testFilters("bun test --timeout 5000 tests")).toThrow(
      /no longer `bun test <dirs>`/,
    );
  });

  test("discovers what bun test would: a filter matches anywhere in the path, hidden directories and node_modules are skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-shard-"));
    try {
      for (const path of [
        "alpha/one.test.ts",
        "alpha/two_test.tsx",
        "alpha/three.spec.js",
        "alpha/four_spec.mts",
        "alpha/nested/five.test.cjs",
        "alpha/helper.ts",
        "alpha/server.integration.ts",
        "alpha/node_modules/dep/x.test.ts",
        "alpha/.cache/y.test.ts",
        "hid/.hidden/alpha/z.test.ts",
        "beta/six.test.ts",
        "gamma/seven.test.ts",
        "xalpha-e2e/eight.test.ts",
        "gamma/beta-side/nine.test.ts",
      ]) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), "");
      }

      expect(discover(root, ["alpha", "beta"])).toEqual([
        "alpha/four_spec.mts",
        "alpha/nested/five.test.cjs",
        "alpha/one.test.ts",
        "alpha/three.spec.js",
        "alpha/two_test.tsx",
        "beta/six.test.ts",
        "gamma/beta-side/nine.test.ts",
        "xalpha-e2e/eight.test.ts",
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
