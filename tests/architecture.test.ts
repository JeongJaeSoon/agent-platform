import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { webUiAllowlist } from "./web-ui-allowlist.ts";

const root = join(import.meta.dir, "..");
const testkit = "@werft-ai/testkit";
const claudeSdk = "@anthropic-ai/claude-agent-sdk";
const runtimeCore = join("packages", "runtime-core");
const claudeAdapter = join("packages", "adapters", "runtimes", "claude");
const dockerBackend = join("packages", "adapters", "execution", "local-docker");
const kubernetesBackend = join(
  "packages",
  "adapters",
  "execution",
  "kubernetes",
);
const platform = join("packages", "platform");
const system = join("packages", "system");
const routes = join("apps", "control-host", "src", "api", "routes");
const worker = join("apps", "worker");
const web = join("apps", "web");
const ui = join("packages", "ui");
const storage = "@werft-ai/storage";
/** The one worker file allowed to know objects live in S3. */
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
  "@werft-ai/db",
  "@werft-ai/storage",
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

async function scriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !entry.parentPath.includes("node_modules"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

const isTestFile = (file: string) =>
  /\.test\.tsx?$/.test(file) || file.includes(`${sep}test-support${sep}`);

/**
 * The web app's view of the workspace: every `@werft-ai/*` package it
 * imports, and each runtime file whose contracts import carries values. The
 * bundle ships to browsers, so it takes contracts as types (no zod), calls the
 * API through packages/client, keys its cache through packages/core, takes
 * the client from packages/react's provider and draws through packages/ui;
 * nothing behind the API is reachable from it.
 */
export async function webBoundaryViolations(
  directory: string,
): Promise<string[]> {
  const allowed = new Set([
    "@werft-ai/client",
    "@werft-ai/contracts",
    "@werft-ai/core",
    "@werft-ai/react",
    "@werft-ai/ui",
  ]);
  const offenders: string[] = [];
  for (const file of await scriptFiles(directory)) {
    const source = await readFile(file, "utf8");
    const name = relative(directory, file);
    for (const specifier of specifiers(source)) {
      const target = packageOf(specifier);
      if (target.startsWith("@werft-ai/") && !allowed.has(target))
        offenders.push(`${name} -> ${specifier}`);
    }
    if (isTestFile(file)) continue;
    for (const match of source.matchAll(
      /import\s+(type\s+)?[^;]*?from\s*["']@werft-ai\/contracts["']/g,
    )) {
      if (!match[1]) offenders.push(`${name} -> contracts value import`);
    }
  }
  return offenders.sort();
}

/** Parsed rather than matched, so comments, strings and JSX text never pass for code. */
async function parse(file: string): Promise<ts.SourceFile> {
  return ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/**
 * PascalCase value names a workspace package exports, read statically from
 * each script entry of its manifest's `exports` and the `export *` chains
 * behind them. Importing the packages instead would load React and
 * happy-dom-sensitive modules into whatever process runs this file.
 */
export async function exportedComponentNames(
  directory: string,
): Promise<Set<string>> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const statement of (await parse(file)).statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const clause = statement.exportClause;
        const from = statement.moduleSpecifier;
        if (!clause && from && ts.isStringLiteral(from)) {
          if (from.text.startsWith("."))
            await visit(moduleFile(file, from.text));
        } else if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements)
            if (!element.isTypeOnly) names.add(element.name.text);
        }
      } else if (isExported(statement)) {
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name
        )
          names.add(statement.name.text);
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (ts.isIdentifier(declaration.name))
              names.add(declaration.name.text);
      }
    }
  };
  const { exports } = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as { exports?: unknown };
  const subpaths =
    typeof exports === "string" ? { ".": exports } : (exports ?? {});
  for (const [subpath, target] of Object.entries(subpaths)) {
    if (subpath.includes("test-support")) continue;
    for (const path of leaves(target))
      if (/\.tsx?$/.test(path)) await visit(join(directory, path));
  }
  // SCREAMING_CASE exports are constants, not components.
  return new Set(
    [...names].filter(
      (name) => /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name),
    ),
  );
}

/** Every string target of a package.json `exports` value, conditions included. */
function leaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(leaves);
  return [];
}

/** The file an extensionless or directory specifier names; an unknown one fails loudly. */
function moduleFile(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  throw new Error(`${from}: cannot resolve export * from "${specifier}"`);
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isLiteralTypeNode(parent) ||
    (ts.isCallExpression(parent) &&
      parent.expression.kind === ts.SyntaxKind.ImportKeyword)
  );
}

const scriptFile = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Module references from runtime files under `directory` that reach a
 * workspace package's `testing/` helpers. Test files and `testing/` itself
 * are test support and may.
 */
async function testingHelperImports(
  directory: string,
): Promise<Array<{ file: string; specifier: string }>> {
  const found: Array<{ file: string; specifier: string }> = [];
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = join(entry.parentPath, entry.name);
    const path = relative(directory, file).split(sep);
    if (
      !entry.isFile() ||
      !scriptFile.test(entry.name) ||
      entry.name.includes(".test.") ||
      path[0] === "testing" ||
      path.includes("node_modules")
    )
      continue;
    walk(await parse(file), (node) => {
      let reference: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        reference = node.moduleSpecifier;
      else if (ts.isExternalModuleReference(node)) reference = node.expression;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        reference = node.argument.literal;
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      )
        reference = node.arguments[0];
      while (reference && ts.isParenthesizedExpression(reference))
        reference = reference.expression;
      if (!reference || !ts.isStringLiteralLike(reference)) return;
      const specifier = reference.text;
      const segments = specifier.startsWith(".")
        ? posix.normalize(specifier).split("/")
        : specifier.startsWith("@werft-ai/")
          ? specifier.split("/").slice(2)
          : [];
      if (segments.includes("testing")) found.push({ file, specifier });
    });
  }
  return found;
}

/**
 * Whether a constant's value is a list of link classes ("text-primary
 * hover:underline"), as opposed to a URL that merely contains "text-".
 */
function isLinkClasses(value: ts.Expression): boolean {
  let inner = value;
  while (
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isParenthesizedExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  )
    inner = inner.expression;
  const text = ts.isStringLiteralLike(inner)
    ? inner.text
    : ts.isTemplateExpression(inner)
      ? [
          inner.head.text,
          ...inner.templateSpans.map((s) => s.literal.text),
        ].join(" ")
      : undefined;
  return (
    text !== undefined &&
    text
      .split(/\s+/)
      // Any variant prefix, data-[active=true]: included; a URL's "//" is not one.
      .some((token) => /(?:^|:)!?(?:text-|underline!?$)/.test(token))
  );
}

/** Count of each web UI rule's matches, per file relative to apps/web/src. */
export type WebUiCounts = Record<string, Partial<Record<WebUiRule, number>>>;

/** What each rule catches, and what to do instead. */
const webUiRules = {
  "raw-table":
    "raw <table>: use a table from @werft-ai/ui (or SessionTable from @werft-ai/react/components); if none fits, ask ui-kit for one",
  "raw-anchor":
    "raw <a>: use the router's link or a link component from @werft-ai/ui; if none fits, ask ui-kit for one",
  "shadow-component":
    "a component named like a @werft-ai/ui or @werft-ai/react export: import that export instead of defining a second one; if it lacks what you need, ask ui-kit to extend it",
  "legacy-class":
    "legacy web-* / ap-input class: use the @werft-ai/ui component that draws it (Field, Input, PageHeader, EmptyState, ...); if none fits, ask ui-kit for one",
  "link-constant":
    "link className constant: use a link component from @werft-ai/ui; if none fits, ask ui-kit for one",
  "raw-destructive":
    "raw text-destructive status text: use ErrorState, FieldError or ApiErrorState; if none fits, ask ui-kit for one",
} as const;

export type WebUiRule = keyof typeof webUiRules;

const legacyClass = /(?<![\w-])(?:web-[a-z0-9_-]+|ap-input[a-z0-9_-]*)/g;

/**
 * Where apps/web draws its own UI instead of composing packages/ui and
 * packages/react. `components` are the names those packages export.
 */
export async function webUiViolations(
  directory: string,
  components: ReadonlySet<string>,
): Promise<WebUiCounts> {
  const counts: WebUiCounts = {};
  const add = (file: string, rule: WebUiRule, n: number) => {
    if (n === 0) return;
    counts[file] = { ...counts[file], [rule]: (counts[file]?.[rule] ?? 0) + n };
  };
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || entry.parentPath.includes("node_modules")) continue;
    const file = join(entry.parentPath, entry.name);
    const name = relative(directory, file);
    if (entry.name.endsWith(".css")) {
      // Every mention, so an attribute selector ([class~="web-x"]) counts too.
      const css = (await readFile(file, "utf8")).replace(
        /\/\*[\s\S]*?\*\//g,
        "",
      );
      add(name, "legacy-class", [...css.matchAll(legacyClass)].length);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || isTestFile(file)) continue;
    walk(await parse(file), (node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName)
      ) {
        if (node.tagName.text === "table") add(name, "raw-table", 1);
        if (node.tagName.text === "a") add(name, "raw-anchor", 1);
      }
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node) ||
          ts.isVariableDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        components.has(node.name.text)
      )
        add(name, "shadow-component", 1);
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        !isModuleSpecifier(node)
      ) {
        // Whole class tokens, so "./web-utils" or ".../web-api" is not one.
        const tokens = node.text.split(/\s+/);
        const classes = (pattern: RegExp) =>
          tokens.filter((token) => pattern.test(token)).length;
        add(
          name,
          "legacy-class",
          classes(/(?:^|:)!?(?:web-[a-z0-9_-]+|ap-input[a-z0-9_-]*)!?$/),
        );
        add(
          name,
          "raw-destructive",
          classes(/(?:^|:)!?text-destructive(?:\/[^\s!]+)?!?$/),
        );
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /link/i.test(node.name.text) &&
        node.initializer &&
        isLinkClasses(node.initializer)
      )
        add(name, "link-constant", 1);
    });
  }
  return counts;
}

/**
 * The ratchet: `actual` may only shrink below `allowed`. A count above the
 * list is new UI drawn in apps/web; a count below it is a fix whose entry
 * must go, so the list never stays larger than what is there.
 */
export function webUiRatchet(
  actual: WebUiCounts,
  allowed: WebUiCounts,
): string[] {
  const problems: string[] = [];
  const files = new Set([...Object.keys(actual), ...Object.keys(allowed)]);
  for (const file of [...files].sort()) {
    for (const rule of Object.keys(webUiRules) as WebUiRule[]) {
      const found = actual[file]?.[rule] ?? 0;
      const listed = allowed[file]?.[rule] ?? 0;
      if (found > listed)
        problems.push(
          `${file} ${rule}: ${found} found, ${listed} allowed. ${webUiRules[rule]}`,
        );
      else if (found < listed)
        problems.push(
          `${file} ${rule}: ${found} found, ${listed} allowed. Lower this entry in tests/web-ui-allowlist.ts to ${found}${found === 0 ? " (remove it)" : ""}`,
        );
    }
  }
  return problems;
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
    expect(names).toContain(kubernetesBackend);
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

  // `src/testing/` helpers can bypass production invariants (commitCheckpoint
  // moves the checkpoint pointer with no turn), so only tests and other
  // helpers may reach them.
  test("no runtime source imports a package's testing helpers", async () => {
    const offenders: string[] = [];
    for (const directory of await workspacePackages())
      for (const { file, specifier } of await testingHelperImports(
        join(directory, "src"),
      ))
        offenders.push(`${relative(root, file)}: ${specifier}`);
    expect(offenders).toEqual([]);
  });

  test("the testing-helper scan sees every literal import form and skips comments and plain strings", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-"));
    try {
      await mkdir(join(fixture, "src", "testing"), { recursive: true });
      const cases: Array<[string, string]> = [
        ["static.ts", 'import { x } from "@werft-ai/db/testing/a";'],
        ["view.tsx", 'import "./testing/a.ts";\nexport const V = () => <p />;'],
        ["dynamic.ts", "export const f = () => import(/* c */ `./testing/a`);"],
        ["required.js", 'module.exports = require("../src/testing/a");'],
        ["reexport.mts", 'export * from "@werft-ai/db/testing/a";'],
        ["commented.ts", '// import "@werft-ai/db/testing/a";'],
        ["climbs.ts", 'import "./testing/../runtime.ts";'],
        ["external.ts", 'import "react-dom/testing/utils";'],
        ["literal.ts", 'export type Route = "./testing/a";'],
        ["wrapped.ts", 'export const g = () => require(("./testing/w"));'],
        ["typed.ts", 'export type T = typeof import("./testing/t");'],
        ["unit.test.tsx", 'import "./testing/a.ts";'],
        [join("testing", "a.ts"), 'import "@werft-ai/db/testing/b";'],
      ];
      for (const [name, body] of cases)
        await writeFile(join(fixture, "src", name), `${body}\n`);
      expect(
        (await testingHelperImports(join(fixture, "src")))
          .map(
            ({ file, specifier }) => `${relative(fixture, file)} ${specifier}`,
          )
          .sort(),
      ).toEqual([
        `${join("src", "dynamic.ts")} ./testing/a`,
        `${join("src", "reexport.mts")} @werft-ai/db/testing/a`,
        `${join("src", "required.js")} ../src/testing/a`,
        `${join("src", "static.ts")} @werft-ai/db/testing/a`,
        `${join("src", "typed.ts")} ./testing/t`,
        `${join("src", "view.tsx")} ./testing/a.ts`,
        `${join("src", "wrapped.ts")} ./testing/w`,
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
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
      "@werft-ai/contracts",
    ]);
    expect([...(await packageImports(directory))]).toEqual([
      "@werft-ai/contracts",
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
      "@werft-ai/db",
      "@werft-ai/platform",
      "@werft-ai/storage",
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
      "@werft-ai/contracts",
      "@werft-ai/runtime-core",
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
    expect(imported).toContain("@werft-ai/contracts");
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
          'import type { Session } from "@werft-ai/contracts";',
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

  test.each([
    ["Docker", dockerBackend],
    ["Kubernetes", kubernetesBackend],
  ])(
    "the %s backend depends on platform and contracts only and never on db, pg or provider SDKs",
    async (_name, backend) => {
      const directory = join(root, backend);
      const allowed = new Set(["@werft-ai/contracts", "@werft-ai/platform"]);
      const declared = [...declaredDependencies(await manifest(directory))];
      const imported = [...(await packageImports(directory))];
      expect(declared.filter((name) => !allowed.has(name))).toEqual([]);
      expect(imported.filter((name) => !allowed.has(name))).toEqual([]);
    },
  );

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

  test("worker Pods never get a hostPath, the host's network or its PID namespace", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(
      join(root, kubernetesBackend, "src"),
    )) {
      const source = await readFile(file, "utf8");
      if (/\b(hostPath|hostNetwork|hostPID|hostIPC)\b/.test(source)) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test.each([
    ["Docker", "@werft-ai/execution-local-docker"],
    ["Kubernetes", "@werft-ai/execution-kubernetes"],
  ])(
    "only the control host's scheduler role reaches the %s backend",
    async (_, backend) => {
      const host = join(root, "apps", "control-host");
      const importing = (
        await filesImporting(await sourceFiles(join(host, "src")), backend)
      ).map((file) => relative(join(host, "src"), file));
      expect(importing.length).toBeGreaterThan(0);
      expect(
        importing.filter((file) => !file.startsWith(`scheduler${sep}`)),
      ).toEqual([]);
    },
  );

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

  test("the worker imports runtime-core, the Claude adapter, contracts, storage, system and observability only", async () => {
    const allowed = new Set([
      "@werft-ai/contracts",
      // The log format and masking rules; it imports nothing itself.
      "@werft-ai/observability",
      "@werft-ai/runtime-claude",
      "@werft-ai/runtime-core",
      storage,
      "@werft-ai/system",
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
        'import type { CheckpointObjectStore } from "@werft-ai/runtime-core";\nexport type S = CheckpointObjectStore;\n',
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

  test("DNS and git process helpers live in system, which depends on nothing, not in runtime-core", async () => {
    const directory = join(root, system);
    expect([...declaredDependencies(await manifest(directory))]).toEqual([]);
    expect([...(await packageImports(directory))]).toEqual([]);
    const core = await import("@werft-ai/runtime-core");
    for (const name of [
      "gitCommand",
      "killProcessGroup",
      "lookupEveryTime",
      "resolveEveryTime",
    ])
      expect(Object.keys(core)).not.toContain(name);
  });

  test("routes know database-backed errors and records through platform ports", async () => {
    const importing = (
      await filesImporting(
        await sourceFiles(join(root, routes)),
        "@werft-ai/db",
      )
    ).map((file) => relative(join(root, routes), file));
    expect(importing).toEqual([]);
  });

  test("the Claude adapter names each export", async () => {
    const adapterEntry = await readFile(
      join(root, claudeAdapter, "src", "index.ts"),
      "utf8",
    );
    expect(adapterEntry).not.toMatch(/export (type )?\*/);
  });

  test("operational scripts take the checkpoint codec from the SDK-free package", async () => {
    const lib = join(root, "scripts", "lib");
    const scripts = await sourceFiles(lib);
    expect(await filesImporting(scripts, "@werft-ai/runtime-claude")).toEqual(
      [],
    );
    expect(
      (await filesImporting(scripts, "@werft-ai/runtime-claude-codec"))
        .map((file) => relative(lib, file))
        .sort(),
    ).toEqual(["checkpoint-pins-cli.ts", "decode-manifest.ts"]);
  });

  test("the worker and the control plane read the checkpoint limits from runtime-core", async () => {
    const own =
      /const (DEFAULT_)?MAX_(MANIFEST_BYTES|MANIFEST_OBJECTS|BUNDLE_CHAIN|WORKSPACE_BUNDLE_BYTES|WORKSPACE_BUNDLE_CHAIN)\b/;
    const declaring: string[] = [];
    for (const directory of [worker, platform]) {
      for (const file of await sourceFiles(join(root, directory, "src"))) {
        if (own.test(await readFile(file, "utf8")))
          declaring.push(relative(root, file));
      }
    }
    expect(declaring).toEqual([]);
    const fromCore = /import\s*\{([^}]*)\}\s*from\s*"@werft-ai\/runtime-core"/g;
    const consumers: Array<[string, string[]]> = [
      [
        join(worker, "src", "session-checkpoints.ts"),
        [
          "DEFAULT_MAX_MANIFEST_BYTES",
          "DEFAULT_MAX_MANIFEST_OBJECTS",
          "MAX_WORKSPACE_BUNDLE_CHAIN",
        ],
      ],
      [
        join(worker, "src", "workspace-capture.ts"),
        ["DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES"],
      ],
      [
        join(platform, "src", "checkpoints", "checkpoint-service.ts"),
        [
          "DEFAULT_MAX_MANIFEST_BYTES",
          "DEFAULT_MAX_MANIFEST_OBJECTS",
          "DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES",
          "MAX_WORKSPACE_BUNDLE_CHAIN",
        ],
      ],
    ];
    for (const [file, limits] of consumers) {
      const source = await readFile(join(root, file), "utf8");
      const imported = [...source.matchAll(fromCore)].flatMap((match) =>
        (match[1] ?? "").split(",").map((name) => name.trim()),
      );
      expect({
        file,
        missing: limits.filter((n) => !imported.includes(n)),
      }).toEqual({
        file,
        missing: [],
      });
    }
  });

  test("the web app imports contracts as types, packages/client, packages/core, packages/react and packages/ui, nothing else of the workspace", async () => {
    expect(await webBoundaryViolations(join(root, web, "src"))).toEqual([]);
    const declared = [
      ...declaredDependencies(await manifest(join(root, web))),
      ...Object.keys((await manifest(join(root, web))).devDependencies ?? {}),
    ].filter((name) => name.startsWith("@werft-ai/"));
    expect(declared.sort()).toEqual([
      "@werft-ai/client",
      "@werft-ai/contracts",
      "@werft-ai/core",
      "@werft-ai/react",
      "@werft-ai/ui",
    ]);
  });

  test("the web boundary check catches a value import and a reach behind the API", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-web-"));
    try {
      await writeFile(
        join(fixture, "screen.tsx"),
        [
          'import { authMeResponseSchema } from "@werft-ai/contracts";',
          'import type { AuthMeResponse } from "@werft-ai/contracts";',
          'import { createPool } from "@werft-ai/db";',
          "const lazy = () => import('@werft-ai/platform');",
        ].join("\n"),
      );
      await writeFile(
        join(fixture, "screen.test.tsx"),
        'import { authMeResponseSchema } from "@werft-ai/contracts";',
      );
      expect(await webBoundaryViolations(fixture)).toEqual([
        "screen.tsx -> @werft-ai/db",
        "screen.tsx -> @werft-ai/platform",
        "screen.tsx -> contracts value import",
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("the web app draws no UI of its own beyond tests/web-ui-allowlist.ts", async () => {
    const components = new Set([
      ...(await exportedComponentNames(join(root, ui))),
      ...(await exportedComponentNames(join(root, "packages", "react"))),
    ]);
    // A reader that found nothing would pass the shadow-component rule vacuously.
    for (const name of ["Card", "EmptyState", "Input", "SessionTable"])
      expect(components).toContain(name);
    expect(
      webUiRatchet(
        await webUiViolations(join(root, web, "src"), components),
        webUiAllowlist,
      ),
    ).toEqual([]);
  });

  test("the web UI ratchet fails on a new violation and on a list larger than the code", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-web-ui-"));
    try {
      await mkdir(join(fixture, "ui", "src"), { recursive: true });
      await writeFile(
        join(fixture, "ui", "package.json"),
        JSON.stringify({
          exports: {
            ".": "./src/index.ts",
            "./styles.css": "./src/styles.css",
          },
        }),
      );
      await writeFile(
        join(fixture, "ui", "src", "index.ts"),
        [
          'export * from "./card.tsx";',
          "export { Badge, type BadgeProps, cn, LOCALES } from './badge.tsx';",
        ].join("\n"),
      );
      await writeFile(
        join(fixture, "ui", "src", "card.tsx"),
        "export function Card() {}\nexport const EmptyState = () => null;",
      );
      const components = await exportedComponentNames(join(fixture, "ui"));
      expect([...components].sort()).toEqual(["Badge", "Card", "EmptyState"]);

      const web = join(fixture, "web");
      await mkdir(join(web, "routes"), { recursive: true });
      await writeFile(
        join(web, "routes", "screen.tsx"),
        [
          "const LINK = 'text-primary underline';",
          "export const PRIMARY_LINK =",
          '  "text-primary";',
          "const LINK_CODES = new Set([1]);",
          "export function Card() {",
          "  return (",
          '    <table className="web-table">',
          '      <a href="/x" className="ap-input web-field__hint">x</a>',
          '      <p className="text-destructive">no</p>',
          "    </table>",
          "  );",
          "}",
          "function Cardboard() { return <abbr />; }",
        ].join("\n"),
      );
      await writeFile(
        join(web, "routes", "screen.test.tsx"),
        '<table className="web-table"><a href="/">x</a></table>',
      );
      await writeFile(
        join(web, "styles.css"),
        ".web-field .ap-input { color: red; }\n.ap-button {}",
      );
      const counts = await webUiViolations(web, components);
      expect(counts).toEqual({
        [join("routes", "screen.tsx")]: {
          "raw-table": 1,
          "raw-anchor": 1,
          "shadow-component": 1,
          "legacy-class": 3,
          "link-constant": 2,
          "raw-destructive": 1,
        },
        "styles.css": { "legacy-class": 2 },
      });

      // Exactly what is listed passes.
      expect(webUiRatchet(counts, counts)).toEqual([]);

      // A violation the list does not have fails, saying what to use instead.
      const added = webUiRatchet(counts, {
        ...counts,
        "styles.css": { "legacy-class": 1 },
      });
      expect(added).toHaveLength(1);
      expect(added[0]).toContain("styles.css legacy-class: 2 found, 1 allowed");
      expect(added[0]).toContain("@werft-ai/ui");
      expect(added[0]).toContain("ask ui-kit");

      // A fix whose entry stayed in the list fails until the entry goes.
      const stale = webUiRatchet(
        { "styles.css": { "legacy-class": 2 } },
        { ...counts, "styles.css": { "legacy-class": 3 } },
      );
      expect(stale).toContain(
        "styles.css legacy-class: 2 found, 3 allowed. Lower this entry in tests/web-ui-allowlist.ts to 2",
      );
      expect(stale).toContain(
        `${join("routes", "screen.tsx")} raw-table: 0 found, 1 allowed. Lower this entry in tests/web-ui-allowlist.ts to 0 (remove it)`,
      );
      expect(stale).toHaveLength(7);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("the web UI scan reads past comments, URLs, generics and every way to declare or export a name", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "arch-web-ui-edge-"));
    try {
      await mkdir(join(fixture, "ui", "src", "parts"), { recursive: true });
      await writeFile(
        join(fixture, "ui", "package.json"),
        JSON.stringify({
          exports: { ".": { import: "./src/index.ts" } },
        }),
      );
      await writeFile(
        join(fixture, "ui", "src", "index.ts"),
        [
          'export * from "./card";',
          'export * from "./parts";',
          "export\ntype { CardProps } from './card';",
          "// export const Ghost = () => null;",
        ].join("\n"),
      );
      await writeFile(
        join(fixture, "ui", "src", "card.tsx"),
        "export const First = () => null, Second = () => null;\nexport const Input = () => null;",
      );
      await writeFile(
        join(fixture, "ui", "src", "parts", "index.ts"),
        "export const APIError = () => null;",
      );
      expect(
        [...(await exportedComponentNames(join(fixture, "ui")))].sort(),
      ).toEqual(["APIError", "First", "Input", "Second"]);

      const web = join(fixture, "web");
      await mkdir(web);
      await writeFile(
        join(web, "clean.tsx"),
        [
          '// <table> <a href="/"> web-field text-destructive',
          "/* const Card = () => null; */",
          "const identity = <table,>(value: table) => value;",
          'const HELP_LINK = "https://example.com/help";',
          'const HOME_LINK = "/home";',
          'const HASH_LINK = "#help";',
          'const help = "Use <a> or <table> for these";',
          "const Copy = () => <p>Don't worry, it's fine.</p>;",
          "function Screen({ title, Input = DefaultInput }) { return <Input />; }",
          "const CardProps = {};",
        ].join("\n"),
      );
      await writeFile(
        join(web, "dirty.tsx"),
        [
          'const LINK: string = "underline";',
          'const OTHER = 0, ROW_LINK = "hover:underline text-primary";',
          'const CONST_LINK = "text-primary underline" as const;',
          'const ACTIVE_LINK = "data-[active=true]:text-primary";',
          'const LOUD_LINK = "hover:underline!";',
          'const linkClassName = "text-primary hover:underline";',
          'const linkHref = "/text-guide";',
          'import { helper } from "./web-utils";',
          'const lazy = () => import("web-lazy");',
          'export const docsUrl = "https://example.com/web-api";',
          'const tone = cn("hover:text-destructive/80", "web-old!");',
          'const Faint = () => <p className="text-destructive/[0.5]">x</p>;',
          "export default memo(function Second() { return <section />; });",
          "const MIXED_LINK = `text-primary ${extra} underline`;",
          'const DOCS_LINK: string = "https://tailwindcss.com/docs/text-decoration-line";',
          "const NAV_LINK = `",
          "  text-primary hover:underline",
          "`;",
          "const Help = () => <><p>Don't worry.</p><a href=\"/help\">Help</a><p>It's fine.</p></>;",
          'const Quoted = () => <p>See "<a href={url}>help</a>" for details.</p>;',
          'const Upload = () => <><input accept="image/*" /><a href={url}>Help</a>{/* hint */}</>;',
          "const help2 = `<a> or <table>`;",
          "const unrelated = 0, Second = () => <div />;",
          "function APIError() { return <a/>; }",
        ].join("\n"),
      );
      await writeFile(
        join(web, "styles.css"),
        '/* .web-old */\n[class~="web-field"] { color: red; }',
      );
      expect(
        await webUiViolations(
          web,
          await exportedComponentNames(join(fixture, "ui")),
        ),
      ).toEqual({
        "dirty.tsx": {
          "raw-anchor": 4,
          "shadow-component": 3,
          "legacy-class": 1,
          "link-constant": 8,
          "raw-destructive": 2,
        },
        "styles.css": { "legacy-class": 1 },
      });

      await writeFile(
        join(fixture, "ui", "src", "index.ts"),
        'export * from "./missing";',
      );
      await expect(exportedComponentNames(join(fixture, "ui"))).rejects.toThrow(
        'cannot resolve export * from "./missing"',
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("the web app's dependencies are build-time only, so no image installs them", async () => {
    // worker installs every workspace with --production; a runtime dependency
    // here would ship React and the router inside the worker image.
    expect((await manifest(join(root, web))).dependencies ?? {}).toEqual({});
  });

  test("packages/ui never fetches", async () => {
    const calls =
      /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnew\s+EventSource\b/;
    const offenders: string[] = [];
    for (const file of await scriptFiles(join(root, ui, "src"))) {
      if (isTestFile(file)) continue;
      const source = await readFile(file, "utf8");
      if (
        calls.test(source) ||
        specifiers(source).some((s) => packageOf(s) === "openapi-fetch")
      )
        offenders.push(relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});
