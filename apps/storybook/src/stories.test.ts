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

async function componentModules(
  indexes = INDEXES,
): Promise<Map<string, string[]>> {
  const modules = new Map<string, string[]>();
  for (const dir of indexes) {
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

// The sidebar title a component's module path puts it under.
const LAYER_TITLES: [string, string][] = [
  ["ui/src/primitives/", "Primitives/"],
  ["ui/src/patterns/", "Patterns/"],
  ["react/src/components/session/", "Domain/Session/"],
  ["react/src/components/status/", "Domain/Status/"],
  ["react/src/components/receipt/", "Domain/Receipt/"],
  ["react/src/components/feedback/", "Domain/Feedback/"],
  ["react/src/blocks/", "Blocks/"],
];

describe("스토리 목록", () => {
  test("스토리의 사이드바 층이 그 컴포넌트의 패키지 경로와 같다", async () => {
    const owner = new Map<string, string>();
    for (const [file, names] of await componentModules([
      ...INDEXES,
      "react/src/blocks/",
    ])) {
      for (const name of names) owner.set(name, file);
    }
    const misplaced: string[] = [];
    let checked = 0;
    for await (const file of new Glob("**/*.stories.tsx").scan({
      cwd: import.meta.dir,
    })) {
      const source = await Bun.file(`${import.meta.dir}/${file}`).text();
      const meta = source.slice(source.indexOf("const meta = {"));
      const title = /title:\s*"([^"]+)"/.exec(meta)?.[1] ?? "";
      // A block's meta names no component (its args would turn required),
      // so its one import from the blocks entry stands in.
      const component =
        /component:\s*(\w+)/.exec(meta)?.[1] ??
        /import\s*\{\s*(\w+)\s*\}\s*from\s*"@werft-ai\/react\/blocks"/.exec(
          source,
        )?.[1];
      const module = component ? owner.get(component) : undefined;
      if (!module) continue;
      const layer = LAYER_TITLES.find(([dir]) => module.startsWith(dir))?.[1];
      checked += 1;
      if (!layer || !title.startsWith(layer)) {
        misplaced.push(`${file}: "${title}" (${module})`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(misplaced).toEqual([]);
  });

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
