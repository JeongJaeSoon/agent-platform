#!/usr/bin/env bun
// Prints the test files one CI shard runs, one `./path` per line.
//
// Bun 1.3 has no `--shard`, so the split happens here: every shard discovers
// the same files `bun run test` would, splits all of them the same way, and
// keeps its own part. No shard sees another's list, so the partition itself
// is asserted before anything is printed — a file dropped here would pass
// silently, which is the one failure this split must not have.
//
// usage: test-shard.ts <index> <total>   (index is 1-based)

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

// Bun's own discovery rule: a `.test`/`_test`/`.spec`/`_spec` suffix on any
// loadable script extension. Hidden directories and node_modules are skipped,
// as Bun skips them.
const TEST_FILE = /(\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?$/;

/** The directories `bun run test` hands to `bun test`, read from package.json. */
export function testRoots(script: string): string[] {
  const match = /^bun test((?: [\w.][\w./-]*)+)$/.exec(script.trim());
  if (!match?.[1]) {
    throw new Error(
      `package.json "test" is no longer \`bun test <dirs>\`, so the shards cannot tell which files it runs: ${script}`,
    );
  }
  return match[1].trim().split(" ");
}

export function discover(cwd: string, roots: string[]): string[] {
  const files = new Set<string>();
  for (const root of roots) {
    for (const path of new Glob(`${root}/**/*`).scanSync({ cwd })) {
      if (!TEST_FILE.test(path)) continue;
      if (path.split("/").includes("node_modules")) continue;
      files.add(path);
    }
  }
  return [...files].sort();
}

/**
 * Longest-processing-time split: heaviest file first, each onto the lightest
 * shard so far. Weight is the file's byte size — on the 150 files of run
 * 35873091897 that came within 3% of a split by measured run time (4 shards:
 * 100s vs 97s longest), with no timing table to keep current. If one shard
 * starts running well past the others, feed it measured times instead.
 */
export function split(
  files: { path: string; weight: number }[],
  total: number,
): string[][] {
  const shards = Array.from({ length: total }, () => ({
    files: [] as string[],
    weight: 0,
  }));
  const heaviestFirst = [...files].sort(
    (a, b) => b.weight - a.weight || a.path.localeCompare(b.path),
  );
  for (const file of heaviestFirst) {
    const lightest = shards.reduce((min, shard) =>
      shard.weight < min.weight ? shard : min,
    );
    lightest.files.push(file.path);
    lightest.weight += file.weight;
  }

  const seen = new Set<string>();
  for (const [index, shard] of shards.entries()) {
    // `bun test` with no path runs the whole suite, so an empty shard would
    // quietly repeat every other shard's work instead of doing nothing.
    if (shard.files.length === 0) {
      throw new Error(`shard ${index + 1}/${total} has no files`);
    }
    for (const path of shard.files) {
      if (seen.has(path)) throw new Error(`${path} is in two shards`);
      seen.add(path);
    }
  }
  if (seen.size !== files.length) {
    throw new Error(`the shards hold ${seen.size} of ${files.length} files`);
  }
  return shards.map((shard) => shard.files.sort());
}

function main(argv: string[]): void {
  const [index, total] = argv.map(Number);
  if (
    argv.length !== 2 ||
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    index < 1 ||
    index > total
  ) {
    console.error("usage: test-shard.ts <index> <total>");
    process.exit(2);
  }

  const cwd = join(import.meta.dir, "..", "..");
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const files = discover(cwd, testRoots(pkg.scripts.test)).map((path) => ({
    path,
    weight: statSync(join(cwd, path)).size,
  }));
  const shards = split(files, total);
  const mine = shards[index - 1] ?? [];

  console.error(
    `shard ${index}/${total}: ${mine.length} of ${files.length} files`,
  );
  for (const path of mine) console.log(`./${path}`);
}

if (import.meta.main) main(process.argv.slice(2));
