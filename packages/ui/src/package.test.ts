import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/*
 * packages/ui draws; it does not fetch, route, or decide. The boundary is a
 * property of the package, so it is checked as one rather than left to review.
 */

const PACKAGE_ROOT = `${import.meta.dir}/..`;

const FORBIDDEN_IMPORTS = [
  "openapi-fetch",
  "@tanstack/",
  "react-router",
  "swr",
  "axios",
  "zustand",
];

const ALLOWED_RUNTIME_DEPENDENCIES = [
  "@radix-ui/react-checkbox",
  "@radix-ui/react-dialog",
  "@radix-ui/react-radio-group",
  "@radix-ui/react-slot",
  "@radix-ui/react-tabs",
  "class-variance-authority",
  "clsx",
  "react",
  "react-dom",
  "tailwind-merge",
];

async function sourceFiles(): Promise<string[]> {
  const glob = new Glob("src/**/*.{ts,tsx}");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: PACKAGE_ROOT })) files.push(file);
  return files.sort();
}

describe("패키지 경계", () => {
  test("API 클라이언트·router·query를 import하지 않는다", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const source = await Bun.file(`${PACKAGE_ROOT}/${file}`).text();
      // Static and dynamic, single- and double-quoted: Biome normalises quotes
      // today, but the boundary must not depend on a formatter to hold.
      const specifiers = source.matchAll(
        /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
      );
      for (const match of specifiers) {
        const specifier = match[1] ?? "";
        if (FORBIDDEN_IMPORTS.some((name) => specifier.startsWith(name))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("직접 네트워크를 부르지 않는다", async () => {
    // Dropping a bare `fetch(...)` into a component needs no import, so the
    // import test above would never see it.
    const calls =
      /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnew\s+EventSource\b/;
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (file.includes(".test.") || file.includes("test-support")) continue;
      const source = await Bun.file(`${PACKAGE_ROOT}/${file}`).text();
      if (calls.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("런타임 의존성이 그림 그리는 데 필요한 것뿐이다", async () => {
    const manifest = await Bun.file(`${PACKAGE_ROOT}/package.json`).json();
    expect(Object.keys(manifest.dependencies).sort()).toEqual(
      ALLOWED_RUNTIME_DEPENDENCIES,
    );
  });

  test("Radix primitive는 primitives/ 안에서만 import한다", async () => {
    // A second import site is a second Dialog: its own overlay, focus return
    // and z-index, drifting apart from the first.
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (file.startsWith("src/primitives/")) continue;
      const source = await Bun.file(`${PACKAGE_ROOT}/${file}`).text();
      if (/\bfrom\s+["']@radix-ui\//.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("contracts를 import하지 않는다", async () => {
    // The kit ships without the API's contracts; whatever takes their types
    // lives in @werft-ai/react/components. Tests included: a test reaching for
    // contracts means the component under it belongs there too.
    // Spelled in pieces so this file does not match its own search.
    const contracts = ["@werft-ai", "contracts"].join("/");
    const manifest = await Bun.file(`${PACKAGE_ROOT}/package.json`).json();
    expect(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      }),
    ).not.toContain(contracts);
    // Any quoted specifier, subpaths included: static, dynamic, side-effect
    // and re-export forms all name the package in quotes.
    const specifier = new RegExp(`["'\`]${contracts}["'\`/]`);
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const source = await Bun.file(`${PACKAGE_ROOT}/${file}`).text();
      if (specifier.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("모든 컴포넌트가 층 index.ts로 나간다", async () => {
    const index = await Bun.file(`${PACKAGE_ROOT}/src/index.ts`).text();
    const LAYERS = ["foundations", "primitives", "patterns"];
    const components = (await sourceFiles()).filter(
      (file) =>
        file.endsWith(".tsx") &&
        !file.includes("__fixtures__") &&
        !file.includes("test-support") &&
        !file.endsWith(".test.tsx"),
    );
    expect(components.length).toBeGreaterThan(0);
    for (const file of components) {
      const [, dir = "", name] = file.match(/^src\/([^/]+)\/(.+)$/) ?? [];
      expect(LAYERS).toContain(dir);
      const layerIndex = await Bun.file(
        `${PACKAGE_ROOT}/src/${dir}/index.ts`,
      ).text();
      expect(layerIndex).toContain(`from "./${name}"`);
      expect(index).toContain(`export * from "./${dir}/index.ts"`);
    }
  });
});
