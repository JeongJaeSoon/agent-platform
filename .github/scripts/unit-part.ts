#!/usr/bin/env bun
// Prints the test files one unit part of `check` runs, one `./path` per line.
//
// `check` runs the suite without services in two parts named after the repo
// layout (94S-305): `packages` is every discovered file under packages/, and
// `rest` is every other one — apps/ and tests/ today. `rest` is the complement
// by construction, so a file cannot fall between the two parts, and a new
// top-level directory the `test` filters pick up lands in `rest` rather than
// nowhere.
//
// usage: unit-part.ts <packages|rest>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discover, testFilters } from "./test-files.ts";

export const PARTS = ["packages", "rest"] as const;
export type Part = (typeof PARTS)[number];

export function partOf(path: string): Part {
  return path.startsWith("packages/") ? "packages" : "rest";
}

export function pick(files: string[], part: Part): string[] {
  const mine = files.filter((path) => partOf(path) === part);
  // `bun test` with no path runs the whole suite, so an empty part would
  // quietly repeat the other part's work instead of doing nothing.
  if (mine.length === 0) throw new Error(`unit part ${part} has no files`);
  return mine;
}

function main(argv: string[]): void {
  const part = argv[0] as Part;
  if (argv.length !== 1 || !PARTS.includes(part)) {
    console.error(`usage: unit-part.ts <${PARTS.join("|")}>`);
    process.exit(2);
  }

  const cwd = join(import.meta.dir, "..", "..");
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const files = discover(cwd, testFilters(pkg.scripts.test));
  const mine = pick(files, part);

  console.error(`unit part ${part}: ${mine.length} of ${files.length} files`);
  for (const path of mine) console.log(`./${path}`);
}

if (import.meta.main) main(process.argv.slice(2));
