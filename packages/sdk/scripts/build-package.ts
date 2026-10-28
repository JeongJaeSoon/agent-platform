/**
 * Builds the publishable @werft-ai/sdk into packages/sdk/dist: one ESM module
 * and one d.ts with the workspace packages it imports (@werft-ai/client, and
 * @werft-ai/contracts types) bundled in, the Apache-2.0 LICENSE and NOTICE,
 * the README, and a package.json whose exports point at those files.
 * `npm pack dist` packs it. The repo's own package.json keeps pointing at src,
 * so the workspace never needs this build.
 *
 *   bun run --cwd packages/sdk build:package
 */

import { cpSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "tsdown";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const OUT = join(PACKAGE_ROOT, "dist");
const WORKSPACE = /^@werft-ai\//;

type Manifest = {
  name: string;
  version: string;
  description: string;
  license: string;
  type: string;
  engines: Record<string, string>;
  repository: Record<string, string>;
  homepage: string;
  bugs: Record<string, string>;
  keywords: string[];
  publishConfig: Record<string, unknown>;
  dependencies: Record<string, string>;
};

const source: Manifest = await Bun.file(
  join(PACKAGE_ROOT, "package.json"),
).json();
const bundled: Manifest[] = await Promise.all(
  ["client", "contracts"].map((name) =>
    Bun.file(join(PACKAGE_ROOT, "..", name, "package.json")).json(),
  ),
);

// What the bundle still imports: the non-workspace dependencies of the SDK
// and of the workspace packages bundled into it. zod is one for the d.ts only:
// contracts types are z.infer of its schemas, and inlining zod's own
// declarations would add most of a megabyte.
const dependencies: Record<string, string> = {};
for (const deps of [source, ...bundled].map((pkg) => pkg.dependencies)) {
  for (const [name, version] of Object.entries(deps ?? {})) {
    if (!WORKSPACE.test(name)) dependencies[name] = version;
  }
}

rmSync(OUT, { recursive: true, force: true });

await build({
  config: false,
  cwd: PACKAGE_ROOT,
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
  // Without eager, tsc emits no declarations for the workspace packages
  // bundled in from outside this package's directory.
  dts: { eager: true },
  sourcemap: false,
  deps: {
    alwaysBundle: [WORKSPACE],
    neverBundle: Object.keys(dependencies),
    dts: { alwaysBundle: [WORKSPACE] },
  },
  outDir: OUT,
  logLevel: "warn",
});

const built = readdirSync(OUT).sort();
if (built.join(" ") !== "index.d.ts index.js") {
  throw new Error(`expected index.js and index.d.ts only, got ${built}`);
}
for (const file of built) {
  const text = await Bun.file(join(OUT, file)).text();
  const leaked = text.match(/from\s+["'](@werft-ai\/[^"']+)["']/);
  if (leaked) throw new Error(`${file} still imports ${leaked[1]}`);
}

for (const file of ["LICENSE", "NOTICE", "README.md"]) {
  cpSync(join(PACKAGE_ROOT, file), join(OUT, file));
}

const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  license: source.license,
  type: source.type,
  engines: source.engines,
  repository: source.repository,
  homepage: source.homepage,
  bugs: source.bugs,
  keywords: source.keywords,
  sideEffects: false,
  types: "./index.d.ts",
  exports: {
    ".": { types: "./index.d.ts", import: "./index.js" },
    "./package.json": "./package.json",
  },
  files: ["index.js", "index.d.ts", "LICENSE", "NOTICE", "README.md"],
  publishConfig: source.publishConfig,
  dependencies,
};
await Bun.write(
  join(OUT, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`built ${source.name}@${source.version} into ${OUT}`);
