import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

// Biome's override for packages/react/src rejects router imports and the
// page's globals file by file; these checks cover what an import rule cannot
// name: a query key written here instead of taken from the core, and a client
// built or a request made here instead of through the one the host passes in.

const ROUTERS = ["@tanstack/react-router", "react-router", "next"];

const sourceFiles = async () =>
  (await readdir(import.meta.dir, { recursive: true })).filter(
    (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
  );

const read = (name: string) => readFile(`${import.meta.dir}/${name}`, "utf8");

const packageName = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

test("the package imports no router, not even as types", async () => {
  const files = await sourceFiles();
  expect(files).toContain("provider.tsx");
  const found: string[] = [];
  for (const name of files) {
    for (const [, from, dynamic] of (await read(name)).matchAll(
      /\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g,
    )) {
      const specifier = from ?? dynamic ?? "";
      if (ROUTERS.includes(packageName(specifier)))
        found.push(`${name} -> ${specifier}`);
    }
  }
  expect(found).toEqual([]);
});

test("query keys come from the core's factories, never written here", async () => {
  const found: string[] = [];
  for (const name of await sourceFiles()) {
    const source = await read(name);
    if (/\bqueryKey\s*:/.test(source)) found.push(`${name}: queryKey:`);
    if (/\bqueryKeys?\s*[:=]\s*\[/.test(source))
      found.push(`${name}: key array`);
  }
  expect(found).toEqual([]);
});

test("the package takes a client and never builds one or fetches itself", async () => {
  const found: string[] = [];
  for (const name of await sourceFiles()) {
    const source = await read(name);
    if (/\bcreateApiClient\b/.test(source))
      found.push(`${name}: createApiClient`);
    if (/\bfetch\s*\(/.test(source)) found.push(`${name}: fetch(`);
  }
  expect(found).toEqual([]);
});
