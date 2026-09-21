import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const testkit = "@agent-platform/testkit";

async function workspacePackages(): Promise<string[]> {
  const directories: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, group), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) directories.push(join(root, group, entry.name));
    }
  }
  return directories;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.parentPath.includes(`${join(directory, "node_modules")}`),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("architecture", () => {
  test("testkit is only ever a devDependency", async () => {
    const offenders: string[] = [];
    for (const directory of await workspacePackages()) {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string>; name?: string };
      if (manifest.name === testkit) continue;
      if (manifest.dependencies?.[testkit] !== undefined) {
        offenders.push(relative(root, directory));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no runtime source imports testkit", async () => {
    const offenders: string[] = [];
    for (const directory of await workspacePackages()) {
      if (directory.endsWith(`${join("packages", "testkit")}`)) continue;
      for (const file of await sourceFiles(join(directory, "src"))) {
        const source = await readFile(file, "utf8");
        if (source.includes(`"${testkit}`))
          offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
