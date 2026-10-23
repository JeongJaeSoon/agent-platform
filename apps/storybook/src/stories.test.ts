import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/*
 * A component packages/ui or @werft-ai/react/components exports but no story
 * imports is invisible in the sidebar, and nothing else would notice. Checked
 * per module: a story that uses any export of button.tsx covers button.tsx.
 */

const PACKAGES = `${import.meta.dir}/../../../packages`;
// The ui root index only re-exports each layer's index, so the layers are
// read; foundations holds no .tsx module.
const INDEXES = [
  "ui/src/primitives/",
  "ui/src/patterns/",
  "react/src/components/",
];
const SPECIFIERS = ["@werft-ai/ui", "@werft-ai/react/components"];

async function componentModules(): Promise<Map<string, string[]>> {
  const modules = new Map<string, string[]>();
  for (const dir of INDEXES) {
    const index = await Bun.file(`${PACKAGES}/${dir}index.ts`).text();
    for (const match of index.matchAll(
      /export\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+\.tsx)"/g,
    )) {
      const names = (match[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => /^[A-Z]/.test(name));
      modules.set(`${dir}${match[2] ?? ""}`, names);
    }
  }
  return modules;
}

async function storyImports(): Promise<Set<string>> {
  const imported = new Set<string>();
  const glob = new Glob("**/*.stories.tsx");
  for await (const file of glob.scan({ cwd: import.meta.dir })) {
    const source = await Bun.file(`${import.meta.dir}/${file}`).text();
    for (const match of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g,
    )) {
      if (!SPECIFIERS.includes(match[2] ?? "")) continue;
      for (const name of (match[1] ?? "").split(",")) {
        imported.add(name.replace(/^\s*type\s+/, "").trim());
      }
    }
  }
  return imported;
}

describe("스토리 목록", () => {
  test("packages/ui와 @werft-ai/react/components의 컴포넌트 모듈마다 스토리가 있다", async () => {
    const modules = await componentModules();
    // An index the pattern stops reading would pass the check below empty.
    for (const dir of INDEXES) {
      expect([...modules.keys()].some((file) => file.startsWith(dir))).toBe(
        true,
      );
    }
    const imported = await storyImports();
    const uncovered = [...modules]
      .filter(([, names]) => !names.some((name) => imported.has(name)))
      .map(([file]) => file);
    expect(uncovered).toEqual([]);
  });
});
