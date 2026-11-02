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
import { join, relative } from "node:path";
import { Glob } from "bun";
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
  devDependencies?: Record<string, string>;
};

// The workspace packages bundled in, by directory under packages/.
const BUNDLED_DIRS = ["client", "contracts"];

const source: Manifest = await Bun.file(
  join(PACKAGE_ROOT, "package.json"),
).json();
const bundled: Manifest[] = await Promise.all(
  BUNDLED_DIRS.map((dir) =>
    Bun.file(join(PACKAGE_ROOT, "..", dir, "package.json")).json(),
  ),
);

// A workspace package missing from BUNDLED_DIRS still gets bundled, but its
// files fall outside the d.ts program's include below, and the d.ts plugin
// then builds and type-checks a whole program per file: 16GB instead of 1GB.
const bundledNames = new Set(bundled.map((pkg) => pkg.name));
for (const pkg of [source, ...bundled]) {
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
  })) {
    if (WORKSPACE.test(name) && !bundledNames.has(name)) {
      throw new Error(`${pkg.name} depends on ${name}; add it to BUNDLED_DIRS`);
    }
  }
}

// What the bundle still imports: the non-workspace dependencies of the SDK
// and of the workspace packages bundled into it. zod is one for the d.ts only:
// contracts types are z.infer of its schemas, and inlining zod's own
// declarations would add most of a megabyte.
const dependencies: Record<string, string> = {};
for (const deps of [source, ...bundled].map((pkg) => pkg.dependencies)) {
  for (const [name, version] of Object.entries(deps ?? {})) {
    // A caret range, so a consumer's own zod 4 is shared instead of doubled.
    if (!WORKSPACE.test(name)) dependencies[name] = `^${version}`;
  }
}

rmSync(OUT, { recursive: true, force: true });

// One d.ts program over every file the bundle reaches. A file outside this
// include gets a program of its own; the plugin below fails the build then.
const sources = ["src", ...BUNDLED_DIRS.map((dir) => `../${dir}/src`)];
const include = sources.map((src) => `${src}/**/*.ts`);
const exclude = sources.map((src) => `${src}/**/*.test.ts`);
const included = (file: string) =>
  include.some((glob) => new Glob(glob).match(file)) &&
  !exclude.some((glob) => new Glob(glob).match(file));

await build({
  config: false,
  cwd: PACKAGE_ROOT,
  entry: ["src/index.ts"],
  format: "esm",
  platform: "neutral",
  // Without eager, tsc emits no declarations for the workspace packages
  // bundled in from outside this package's directory.
  dts: { eager: true, tsconfigRaw: { include, exclude } },
  plugins: [
    {
      name: "dts-program-roots",
      buildEnd() {
        const missed = [...this.getModuleIds()]
          // The d.ts plugin takes JSON modules as well as TS ones.
          .filter((id) => /\.([cm]?tsx?|json)$/.test(id))
          .filter((id) => !/\.d\.[cm]?ts$/.test(id))
          .filter((id) => !id.includes("/node_modules/"))
          .map((id) => relative(PACKAGE_ROOT, id))
          .filter((file) => !included(file));
        if (missed.length > 0) {
          throw new Error(
            `outside the d.ts include, each costs a program: ${missed.join(", ")}`,
          );
        }
      },
    },
  ],
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
    ".": {
      types: "./index.d.ts",
      import: "./index.js",
      default: "./index.js",
    },
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
