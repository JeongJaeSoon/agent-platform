import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Biome's override for packages/core/src rejects these imports and DOM
// globals file by file. What it cannot see is the graph: the root entry must
// not reach zod through another workspace package either, so the runtime
// imports are followed from index.ts across the workspace.

const UI = ["react", "react-dom", "@tanstack/react-query"];
const ROUTERS = ["@tanstack/react-router", "react-router", "next"];

const sourceFiles = async () =>
  (await readdir(import.meta.dir)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

const specifiers = (source: string) =>
  [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)].map(
    (match) => (match[1] ?? match[2])!,
  );

const packageName = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

/** Every third-party package the runtime imports from `entry` reach. */
async function runtimeGraph(entry: string): Promise<Set<string>> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    // scanImports drops `import type`, so only what ships is followed.
    for (const { path } of transpiler.scanImports(
      await readFile(file, "utf8"),
    )) {
      if (path.startsWith("node:")) continue;
      if (path.startsWith(".")) {
        await visit(resolve(dirname(file), path));
      } else if (path.startsWith("@agent-platform/")) {
        await visit(Bun.resolveSync(path, dirname(file)));
      } else {
        external.add(packageName(path));
      }
    }
  };
  await visit(entry);
  return external;
}

test("the package source names no UI framework, router or schema library, not even as types", async () => {
  const files = await sourceFiles();
  expect(files).toContain("index.ts");
  const found: string[] = [];
  for (const name of files) {
    const source = await readFile(`${import.meta.dir}/${name}`, "utf8");
    for (const specifier of specifiers(source)) {
      const pkg = packageName(specifier);
      if ([...UI, ...ROUTERS, "zod"].includes(pkg)) {
        found.push(`${name} -> ${specifier}`);
      }
    }
  }
  expect(found).toEqual([]);
});

test("the root entry reaches no zod and no UI framework at runtime", async () => {
  const reached = await runtimeGraph(`${import.meta.dir}/index.ts`);
  // The graph does cross into the client; an empty set would prove nothing.
  expect(reached).toContain("openapi-fetch");
  expect([...reached].filter((pkg) => [...UI, "zod"].includes(pkg))).toEqual(
    [],
  );
});

test("the package takes a client and never builds one or fetches itself", async () => {
  const found: string[] = [];
  for (const name of await sourceFiles()) {
    const source = await readFile(`${import.meta.dir}/${name}`, "utf8");
    if (/\bcreateApiClient\b/.test(source))
      found.push(`${name}: createApiClient`);
    if (/\bfetch\s*\(/.test(source)) found.push(`${name}: fetch(`);
  }
  expect(found).toEqual([]);
});
