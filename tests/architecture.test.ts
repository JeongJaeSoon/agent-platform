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

async function typescriptFiles(
  directory: string,
  keep: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        keep(entry.name) &&
        !entry.parentPath.includes(`${join(directory, "node_modules")}`),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

function sourceFiles(directory: string): Promise<string[]> {
  return typescriptFiles(directory, (name) => !name.endsWith(".test.ts"));
}

function testFiles(directory: string): Promise<string[]> {
  return typescriptFiles(directory, (name) => name.endsWith(".test.ts"));
}

describe("architecture", () => {
  test("testkit is only ever a devDependency", async () => {
    const offenders: string[] = [];
    for (const directory of await workspacePackages()) {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as Record<string, Record<string, string> | string | undefined>;
      if (manifest.name === testkit) continue;
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const section = manifest[field];
        if (typeof section === "object" && section[testkit] !== undefined) {
          offenders.push(`${relative(root, directory)} (${field})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every package whose tests import testkit declares it as a devDependency", async () => {
    const missing: string[] = [];
    for (const directory of await workspacePackages()) {
      if (directory.endsWith(`${join("packages", "testkit")}`)) continue;
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string> };
      let imports = false;
      for (const file of await testFiles(join(directory, "src"))) {
        if ((await readFile(file, "utf8")).includes(`"${testkit}`)) {
          imports = true;
          break;
        }
      }
      if (imports && manifest.devDependencies?.[testkit] === undefined) {
        missing.push(relative(root, directory));
      }
    }
    expect(missing).toEqual([]);
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
