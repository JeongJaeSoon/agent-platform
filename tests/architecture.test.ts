import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = join(import.meta.dir, "..");
const testkit = "@agent-platform/testkit";
const claudeSdk = "@anthropic-ai/claude-agent-sdk";
const runtimeCore = join("packages", "runtime-core");
const claudeAdapter = join("packages", "adapters", "runtimes", "claude");
const dockerBackend = join("packages", "adapters", "execution", "local-docker");
const platform = join("packages", "platform");
const worker = join("apps", "worker");
const storage = "@agent-platform/storage";
/** The one worker file allowed to know objects live in S3 (94S-244). */
const workerObjectStore = join(worker, "src", "object-store.ts");

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[];
};

async function manifest(directory: string): Promise<Manifest> {
  return JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as Manifest;
}

async function workspacePackages(): Promise<string[]> {
  const directories: string[] = [];
  for (const pattern of (await manifest(root)).workspaces ?? []) {
    if (!pattern.endsWith("/*")) throw new Error(`Unsupported glob ${pattern}`);
    const group = pattern.slice(0, -2);
    for (const entry of await readdir(join(root, group), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, group, entry.name);
      if (await Bun.file(join(directory, "package.json")).exists())
        directories.push(directory);
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

// Static imports, re-exports and import() calls, whichever quote they use.
const importPattern =
  /(?:from|import)\s*\(?\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;

function specifierOf(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function specifiers(source: string): string[] {
  return [...source.matchAll(importPattern)].map(specifierOf);
}

function packageOf(specifier: string): string {
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

/** Files under `files` whose imports resolve to the workspace package `name`. */
async function filesImporting(
  files: string[],
  name: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (specifiers(source).some((s) => packageOf(s) === name)) found.push(file);
  }
  return found;
}

async function packageImports(directory: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (const file of await sourceFiles(join(directory, "src"))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = specifierOf(match);
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (specifier === "bun") continue;
      found.add(
        specifier
          .split("/")
          .slice(0, specifier.startsWith("@") ? 2 : 1)
          .join("/"),
      );
    }
  }
  return found;
}

function declaredDependencies(manifest: Manifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

/**
 * Files under `directory`/src that import `name`, other than `allowed`
 * (relative to `directory`). The worker's storage dependency is confined to
 * one file so that the turn loop and the runtime adapter keep taking the
 * object-store port rather than an S3 client.
 */
export async function importsOutside(
  directory: string,
  name: string,
  allowed: string,
): Promise<string[]> {
  const files = await filesImporting(
    await sourceFiles(join(directory, "src")),
    name,
  );
  return files
    .map((file) => relative(directory, file))
    .filter((file) => file !== allowed)
    .sort();
}

/**
 * `forbidden` entries match a package and everything under it, so a bare
 * scope ("@aws-sdk") covers each of its packages.
 */
function isForbidden(name: string, forbidden: readonly string[]): boolean {
  return forbidden.some(
    (entry) => name === entry || name.startsWith(`${entry}/`),
  );
}

/** Files, test files included, that import anything `forbidden` names. */
export async function forbiddenImports(
  directory: string,
  forbidden: readonly string[],
): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await typescriptFiles(
    join(directory, "src"),
    () => true,
  )) {
    for (const specifier of specifiers(await readFile(file, "utf8"))) {
      if (isForbidden(packageOf(specifier), forbidden))
        offenders.push(`${relative(directory, file)} -> ${specifier}`);
    }
  }
  return offenders.sort();
}

// What stays behind the platform ports (module-design.md): the business
// logic never sees a driver, an ORM, a cloud SDK or an agent SDK.
const platformForbidden = [
  "@agent-platform/db",
  "@agent-platform/storage",
  "@anthropic-ai",
  "@aws-sdk",
  "drizzle-orm",
  "pg",
];

export async function escapingRelativeImports(
  directory: string,
): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await sourceFiles(join(directory, "src"))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = specifierOf(match);
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (relative(directory, target).startsWith(".."))
        offenders.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
  return offenders;
}

describe("architecture", () => {
  test("no source file reaches outside its own package through a relative import", async () => {
    const offenders: string[] = [];
    for (const directory of await workspacePackages()) {
      offenders.push(...(await escapingRelativeImports(directory)));
    }
    expect(offenders).toEqual([]);
  });

  test("the relative-import check catches a path that escapes the package", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-"));
    try {
      await mkdir(join(fixture, "src"), { recursive: true });
      await writeFile(
        join(fixture, "src", "leak.ts"),
        [
          'import { pool } from "../../db/src/pool.ts";',
          "export * from '../../platform/src/index.ts';",
          "export const lazy = () => import(`../../storage/src/index.ts`);",
          'import { ok } from "./sibling.ts";',
          "export const p = pool;",
        ].join("\n"),
      );
      expect(await escapingRelativeImports(fixture)).toHaveLength(3);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("workspace globs include every nested package directory", async () => {
    const names = (await workspacePackages()).map((d) => relative(root, d));
    expect(names).toContain(runtimeCore);
    expect(names).toContain(claudeAdapter);
    expect(names).toContain(dockerBackend);
    expect(names).toContain(worker);
  });

  test("testkit is only ever a devDependency", async () => {
    const offenders: string[] = [];
    for (const directory of await workspacePackages()) {
      const pkg = await manifest(directory);
      if (pkg.name === testkit) continue;
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ] as const) {
        if (pkg[field]?.[testkit] !== undefined) {
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
      const pkg = await manifest(directory);
      const imports =
        (await filesImporting(await testFiles(join(directory, "src")), testkit))
          .length > 0;
      if (imports && pkg.devDependencies?.[testkit] === undefined) {
        missing.push(relative(root, directory));
      }
    }
    expect(missing).toEqual([]);
  });

  test("no runtime source imports testkit", async () => {
    const offenders: string[] = [];
    for (const directory of await workspacePackages()) {
      if (directory.endsWith(`${join("packages", "testkit")}`)) continue;
      for (const file of await filesImporting(
        await sourceFiles(join(directory, "src")),
        testkit,
      ))
        offenders.push(relative(root, file));
    }
    expect(offenders).toEqual([]);
  });

  test("the import scan sees single-quoted and template-literal specifiers", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-"));
    try {
      await mkdir(join(fixture, "src"), { recursive: true });
      const cases: Array<[string, string]> = [
        ["single.ts", `import { x } from '${claudeSdk}';`],
        [
          "template.ts",
          "export const load = () => import(`" + claudeSdk + "`);",
        ],
        ["reexport.ts", `export * from "${claudeSdk}/sdk.mjs";`],
        ["clean.ts", `import { y } from "${testkit}/workspace";`],
      ];
      for (const [name, body] of cases)
        await writeFile(join(fixture, "src", name), `${body}\n`);
      const files = await sourceFiles(join(fixture, "src"));
      const sdk = (await filesImporting(files, claudeSdk)).map((f) =>
        relative(fixture, f),
      );
      expect(sdk.sort()).toEqual([
        join("src", "reexport.ts"),
        join("src", "single.ts"),
        join("src", "template.ts"),
      ]);
      const kit = (await filesImporting(files, testkit)).map((f) =>
        relative(fixture, f),
      );
      expect(kit).toEqual([join("src", "clean.ts")]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("the Claude SDK is imported only by the adapter's runtime and run modules", async () => {
    const importing: string[] = [];
    for (const directory of await workspacePackages()) {
      for (const file of await filesImporting(
        await sourceFiles(join(directory, "src")),
        claudeSdk,
      ))
        importing.push(relative(root, file));
    }
    expect(importing.sort()).toEqual([
      join(claudeAdapter, "src", "run.ts"),
      join(claudeAdapter, "src", "runtime.ts"),
    ]);
  });

  test("only the Claude adapter declares the Claude SDK dependency", async () => {
    const declaring: string[] = [];
    for (const directory of await workspacePackages()) {
      if (declaredDependencies(await manifest(directory)).has(claudeSdk))
        declaring.push(relative(root, directory));
    }
    expect(declaring).toEqual([claudeAdapter]);
  });

  test("runtime-core depends on contracts only and never mentions the Claude SDK", async () => {
    const directory = join(root, runtimeCore);
    expect([...declaredDependencies(await manifest(directory))]).toEqual([
      "@agent-platform/contracts",
    ]);
    expect([...(await packageImports(directory))]).toEqual([
      "@agent-platform/contracts",
    ]);
    const mentions: string[] = [];
    for (const file of await sourceFiles(join(directory, "src"))) {
      if ((await readFile(file, "utf8")).includes("@anthropic-ai"))
        mentions.push(relative(root, file));
    }
    expect(mentions).toEqual([]);
  });

  test("the Claude adapter never reaches into platform, db or storage", async () => {
    const directory = join(root, claudeAdapter);
    const forbidden = [
      "@agent-platform/db",
      "@agent-platform/platform",
      "@agent-platform/storage",
      "@aws-sdk",
      "pg",
    ];
    const declared = [...declaredDependencies(await manifest(directory))];
    const imported = [...(await packageImports(directory))];
    expect(declared.filter((name) => isForbidden(name, forbidden))).toEqual([]);
    expect(imported.filter((name) => isForbidden(name, forbidden))).toEqual([]);
  });

  test("platform depends on contracts, runtime-core and zod only", async () => {
    const directory = join(root, platform);
    const allowed = new Set([
      "@agent-platform/contracts",
      "@agent-platform/runtime-core",
      "zod",
    ]);
    const declared = [...declaredDependencies(await manifest(directory))];
    // The import scan also picks up prose such as 'from "paused"' in
    // platform's comments; only a name that resolves to an installed package
    // is an import.
    const installed = (name: string) =>
      [root, directory].some((base) =>
        existsSync(join(base, "node_modules", name)),
      );
    const imported = [...(await packageImports(directory))].filter(installed);
    expect(declared.filter((name) => !allowed.has(name))).toEqual([]);
    expect(imported.filter((name) => !allowed.has(name))).toEqual([]);
    expect(imported).toContain("@agent-platform/contracts");
  });

  test("no platform file, tests included, imports a driver, ORM or SDK", async () => {
    expect(
      await forbiddenImports(join(root, platform), platformForbidden),
    ).toEqual([]);
  });

  test("the forbidden-import check matches subpaths and whole scopes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-"));
    try {
      await mkdir(join(fixture, "src"), { recursive: true });
      await writeFile(
        join(fixture, "src", "leak.test.ts"),
        [
          'import { drizzle } from "drizzle-orm/node-postgres";',
          "import { S3Client } from '@aws-sdk/client-s3';",
          'import { query } from "@anthropic-ai/claude-agent-sdk";',
          'import { Pool } from "pg";',
          'import { pgTable } from "pg-core-lookalike";',
          'import type { Session } from "@agent-platform/contracts";',
        ].join("\n"),
      );
      expect(await forbiddenImports(fixture, platformForbidden)).toEqual([
        "src/leak.test.ts -> @anthropic-ai/claude-agent-sdk",
        "src/leak.test.ts -> @aws-sdk/client-s3",
        "src/leak.test.ts -> drizzle-orm/node-postgres",
        "src/leak.test.ts -> pg",
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("no app imports or depends on another app", async () => {
    const appDirectories = (await workspacePackages()).filter(
      (directory) => relative(root, directory).split(sep)[0] === "apps",
    );
    const appNames = new Set<string>();
    for (const directory of appDirectories) {
      const name = (await manifest(directory)).name;
      if (name) appNames.add(name);
    }
    const offenders: string[] = [];
    for (const directory of appDirectories) {
      const own = (await manifest(directory)).name;
      const reached = new Set([
        ...declaredDependencies(await manifest(directory)),
        ...(await packageImports(directory)),
      ]);
      for (const name of reached) {
        if (name !== own && appNames.has(name))
          offenders.push(`${relative(root, directory)} -> ${name}`);
      }
    }
    expect(appNames.size).toBeGreaterThan(1);
    expect(offenders).toEqual([]);
  });

  test("the Docker backend depends on platform and contracts only and never on db, pg or Docker SDKs", async () => {
    const directory = join(root, dockerBackend);
    const allowed = new Set([
      "@agent-platform/contracts",
      "@agent-platform/platform",
    ]);
    const declared = [...declaredDependencies(await manifest(directory))];
    const imported = [...(await packageImports(directory))];
    expect(declared.filter((name) => !allowed.has(name))).toEqual([]);
    expect(imported.filter((name) => !allowed.has(name))).toEqual([]);
  });

  test("worker containers never get the Docker socket or a host bind mount", async () => {
    // The Engine API body is the contract: a bind mount would be a `Binds`
    // key or a `Type: "bind"` mount, and neither may appear in the backend.
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(root, dockerBackend, "src"))) {
      const source = await readFile(file, "utf8");
      if (/\bBinds\b/.test(source) || /Type:\s*"bind"/.test(source)) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the control host is one app with one executable and three roles", async () => {
    const host = join(root, "apps", "control-host", "src");
    const missing: string[] = [];
    for (const name of [
      "main.ts",
      join("api", "server.ts"),
      join("scheduler", "main.ts"),
      join("reconciler", "main.ts"),
    ]) {
      if (!(await Bun.file(join(host, name)).exists())) missing.push(name);
    }
    expect(missing).toEqual([]);
    for (const gone of ["api", "scheduler", "reconciler"])
      expect(existsSync(join(root, "apps", gone))).toBe(false);
  });

  test("only the control host's scheduler role reaches the Docker backend", async () => {
    const host = join(root, "apps", "control-host");
    const importing = (
      await filesImporting(
        await sourceFiles(join(host, "src")),
        "@agent-platform/execution-local-docker",
      )
    ).map((file) => relative(join(host, "src"), file));
    expect(importing.length).toBeGreaterThan(0);
    expect(
      importing.filter((file) => !file.startsWith(`scheduler${sep}`)),
    ).toEqual([]);
  });

  test("the worker keeps its process layout: entry, composition, host, transport, heartbeat", async () => {
    // The composition root is a named file rather than a habit: it is what
    // keeps the turn loop from reaching for a database pool of its own.
    const missing: string[] = [];
    for (const name of [
      "main.ts",
      "composition.ts",
      "worker-host.ts",
      "gateway-client.ts",
      "heartbeat.ts",
    ]) {
      if (!(await Bun.file(join(root, worker, "src", name)).exists()))
        missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test("the worker imports runtime-core, the Claude adapter, contracts and storage only", async () => {
    const allowed = new Set([
      "@agent-platform/contracts",
      "@agent-platform/runtime-claude",
      "@agent-platform/runtime-core",
      storage,
    ]);
    const directory = join(root, worker);
    const declared = [...declaredDependencies(await manifest(directory))];
    const imported = [...(await packageImports(directory))];
    expect(declared.filter((name) => !allowed.has(name))).toEqual([]);
    expect(imported.filter((name) => !allowed.has(name))).toEqual([]);
  });

  test("only the worker's object-store module imports storage", async () => {
    const directory = join(root, worker);
    expect(
      await importsOutside(
        directory,
        storage,
        relative(directory, join(root, workerObjectStore)),
      ),
    ).toEqual([]);
    // The allowance is not vacuous: the module exists and does import it.
    expect(
      (await filesImporting([join(root, workerObjectStore)], storage)).map(
        (f) => relative(root, f),
      ),
    ).toEqual([workerObjectStore]);
  });

  test("the storage-import check catches a second worker file reaching for S3", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-"));
    try {
      await mkdir(join(fixture, "src"), { recursive: true });
      await writeFile(
        join(fixture, "src", "object-store.ts"),
        `import { createStorageS3Client } from "${storage}";\nexport const c = createStorageS3Client;\n`,
      );
      await writeFile(
        join(fixture, "src", "worker-host.ts"),
        `import { createCheckpointObjectStore } from '${storage}';\nexport const s = createCheckpointObjectStore;\n`,
      );
      await writeFile(
        join(fixture, "src", "reexport.ts"),
        `export * from "${storage}/src/s3.ts";\n`,
      );
      await writeFile(
        join(fixture, "src", "lazy.ts"),
        "export const load = () => import(`" + storage + "`);\n",
      );
      await writeFile(
        join(fixture, "src", "clean.ts"),
        'import type { CheckpointObjectStore } from "@agent-platform/runtime-core";\nexport type S = CheckpointObjectStore;\n',
      );
      expect(
        await importsOutside(fixture, storage, join("src", "object-store.ts")),
      ).toEqual([
        join("src", "lazy.ts"),
        join("src", "reexport.ts"),
        join("src", "worker-host.ts"),
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
