import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

// Biome's override for packages/client/src rejects DOM and runtime globals and
// UI or schema imports. What it cannot tell apart is checked here: contracts
// pulls zod at runtime, so it may be imported for types only, and a browser
// must never be handed an API key option.
const FORBIDDEN: readonly [RegExp, string][] = [
  [
    /^import (?!type )[^;]*from "@agent-platform\/contracts/m,
    "contracts at runtime",
  ],
  [
    /^export (?!type )[^;]*from "@agent-platform\/contracts/m,
    "contracts at runtime",
  ],
  [/\bapiKey\b/i, "an API key option"],
];

test("the package source imports contracts as types only and has no API key option", async () => {
  const files = (await readdir(import.meta.dir)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  expect(files).toContain("client.ts");
  const found: string[] = [];
  for (const name of files) {
    const source = await readFile(`${import.meta.dir}/${name}`, "utf8");
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(source)) found.push(`${name}: ${what}`);
    }
  }
  expect(found).toEqual([]);
});
