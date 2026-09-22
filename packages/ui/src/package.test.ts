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
  "@agent-platform/contracts",
  "@radix-ui/react-dialog",
  "clsx",
  "react",
  "react-dom",
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
      for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
        const specifier = match[1] ?? "";
        if (FORBIDDEN_IMPORTS.some((name) => specifier.startsWith(name))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("런타임 의존성이 그림 그리는 데 필요한 것뿐이다", async () => {
    const manifest = await Bun.file(`${PACKAGE_ROOT}/package.json`).json();
    expect(Object.keys(manifest.dependencies).sort()).toEqual(
      ALLOWED_RUNTIME_DEPENDENCIES,
    );
  });

  test("contracts는 타입으로만 쓴다", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const source = await Bun.file(`${PACKAGE_ROOT}/${file}`).text();
      const imports = source.matchAll(
        /import\s+(type\s+)?[^;]*?from\s+"@agent-platform\/contracts"/g,
      );
      for (const match of imports) {
        // A value import would drag zod into the browser bundle for nothing.
        if (!match[1]) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("모든 컴포넌트가 index.ts로 나간다", async () => {
    const index = await Bun.file(`${PACKAGE_ROOT}/src/index.ts`).text();
    const components = (await sourceFiles()).filter(
      (file) =>
        file.endsWith(".tsx") &&
        !file.includes("__fixtures__") &&
        !file.includes("test-support") &&
        !file.endsWith(".test.tsx") &&
        // Internal to StatusLabel; exporting it would invite a second icon set.
        !file.endsWith("axis-icon.tsx"),
    );
    expect(components.length).toBeGreaterThan(0);
    for (const file of components) {
      const specifier = file.replace(/^src\//, "./");
      expect(index).toContain(`from "${specifier}"`);
    }
  });
});
