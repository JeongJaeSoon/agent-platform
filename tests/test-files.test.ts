import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discover, testFilters } from "../.github/scripts/test-files.ts";

const repo = join(import.meta.dir, "..");

describe("test-files.ts", () => {
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
    const root = await mkdtemp(join(tmpdir(), "test-files-"));
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
});
