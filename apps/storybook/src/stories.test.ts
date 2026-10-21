import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/*
 * A component packages/ui exports but no story imports is invisible in the
 * sidebar, and nothing else would notice. Checked per module: a story that
 * uses any export of button.tsx covers button.tsx.
 */

const UI_INDEX = `${import.meta.dir}/../../../packages/ui/src/index.ts`;

async function componentModules(): Promise<Map<string, string[]>> {
  const index = await Bun.file(UI_INDEX).text();
  const modules = new Map<string, string[]>();
  for (const match of index.matchAll(
    /export\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+\.tsx)"/g,
  )) {
    const names = (match[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => /^[A-Z]/.test(name));
    modules.set(match[2] ?? "", names);
  }
  return modules;
}

async function storyImports(): Promise<Set<string>> {
  const imported = new Set<string>();
  const glob = new Glob("**/*.stories.tsx");
  for await (const file of glob.scan({ cwd: import.meta.dir })) {
    const source = await Bun.file(`${import.meta.dir}/${file}`).text();
    for (const match of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"@agent-platform\/ui"/g,
    )) {
      for (const name of (match[1] ?? "").split(",")) {
        imported.add(name.replace(/^\s*type\s+/, "").trim());
      }
    }
  }
  return imported;
}

describe("스토리 목록", () => {
  test("packages/ui의 컴포넌트 모듈마다 스토리가 있다", async () => {
    const modules = await componentModules();
    expect(modules.size).toBeGreaterThan(0);
    const imported = await storyImports();
    const uncovered = [...modules]
      .filter(([, names]) => !names.some((name) => imported.has(name)))
      .map(([file]) => file);
    expect(uncovered).toEqual([]);
  });
});
