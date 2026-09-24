/**
 * THIRD_PARTY_NOTICES.md: the third-party components each deploy image
 * carries and their licenses (94S-338).
 *
 *   bun scripts/third-party-notices.ts                  rewrite the file
 *   bun scripts/third-party-notices.ts --check          fail when it is stale
 *   bun scripts/third-party-notices.ts --verify <image> <app-dir>
 *                                                        fail when a package
 *     under <app-dir>/node_modules is not listed for that image; images.yml
 *     runs it inside each built image against /app
 *
 * The package list is each image's production closure, read from bun.lock the
 * way its Dockerfile installs it: control-host with `--filter
 * ./apps/control-host`, worker with every workspace, egress-proxy with none.
 * Optional dependencies count for linux on x64 and arm64, the two arches the
 * images are built for, so the list is the same on every machine that runs
 * this. License and NOTICE come from the installed package in node_modules;
 * a platform build this machine did not install (the other arch's binary)
 * takes its license from the npm registry when writing, and from the
 * committed file when checking, so `--check` needs no network.
 *
 * A license outside PERMISSIVE fails both modes unless REVIEWED names the
 * package, with that license, and the reason it may ship. That is the point
 * where a new copyleft or proprietary dependency gets a person's attention.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const IMAGES = ["control-host", "worker", "egress-proxy"] as const;
export type Image = (typeof IMAGES)[number];

/** Which workspaces each image's `bun install --production` starts from. */
const IMAGE_ROOTS: Record<Image, "all" | readonly string[]> = {
  "control-host": ["apps/control-host"],
  worker: "all",
  "egress-proxy": [],
};

const TARGET_OS = "linux";
const TARGET_CPUS = ["x64", "arm64"];

/** SPDX ids that carry no obligation beyond keeping the license text. */
const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/**
 * Packages whose license is not in PERMISSIVE, each with the license that was
 * reviewed and why it may ship. Keyed by name, or by a name prefix ending in
 * `*` for a family of platform builds. A package whose license changes is
 * no longer covered: the new terms need their own review.
 */
export const REVIEWED: Record<string, { license: string; reason: string }> = {
  "@anthropic-ai/claude-agent-sdk": {
    license: "SEE LICENSE IN README.md",
    reason:
      "Anthropic 상용 약관(패키지의 README.md·LICENSE.md). worker 이미지에만 들어간다. 약관 검토는 94S-338 범위 밖이다.",
  },
  "@anthropic-ai/claude-agent-sdk-linux-*": {
    license: "SEE LICENSE IN LICENSE.md",
    reason:
      "위 SDK의 플랫폼별 Claude Code 실행 파일. 같은 약관이다. musl 빌드는 worker Dockerfile이 지운다.",
  },
};

export type LockPackage = {
  key: string;
  name: string;
  version: string;
  optional: boolean;
};

type LockEntry = [
  string,
  string?,
  {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalPeers?: string[];
    os?: string | string[];
    cpu?: string | string[];
  }?,
  string?,
];

type Workspace = {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type Lockfile = {
  workspaces: Record<string, Workspace>;
  packages: Record<string, LockEntry>;
};

export function parseLockfile(text: string): Lockfile {
  return Bun.JSONC.parse(text) as Lockfile;
}

/** `@scope/a/b/@scope/c` → [`@scope/a`, `b`, `@scope/c`]. */
function keyPath(key: string): string[] {
  const parts = key.split("/");
  const path: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    path.push(part.startsWith("@") ? `${part}/${parts[++i]}` : part);
  }
  return path;
}

function matches(
  constraint: string | string[] | undefined,
  targets: readonly string[],
): boolean {
  if (constraint === undefined) return true;
  const list = Array.isArray(constraint) ? constraint : [constraint];
  const negated = list.filter((entry) => entry.startsWith("!"));
  if (negated.length === list.length) {
    return targets.some((target) => !negated.includes(`!${target}`));
  }
  return targets.some((target) => list.includes(target));
}

/**
 * The npm packages `bun install --production` puts in an image, keyed by
 * lockfile key. Workspace packages are followed but not returned: they are
 * this repository's own code.
 */
export function imageClosure(
  lock: Lockfile,
  image: Image,
): Map<string, LockPackage> {
  const roots = IMAGE_ROOTS[image];
  const workspaceByName = new Map(
    Object.entries(lock.workspaces).map(([path, workspace]) => [
      workspace.name,
      path,
    ]),
  );
  const found = new Map<string, LockPackage>();
  const seenWorkspaces = new Set<string>();

  const resolve = (from: string[], name: string): string | undefined => {
    for (let depth = from.length; depth >= 0; depth -= 1) {
      const key = [...from.slice(0, depth), name].join("/");
      if (lock.packages[key] !== undefined) return key;
    }
    return undefined;
  };

  const visitWorkspace = (path: string) => {
    if (seenWorkspaces.has(path)) return;
    seenWorkspaces.add(path);
    const workspace = lock.workspaces[path];
    if (workspace === undefined) throw new Error(`no workspace ${path}`);
    const from = path === "" ? [] : [workspace.name];
    for (const [name, optional] of dependencyNames(workspace, [])) {
      visitDependency(from, name, optional);
    }
  };

  const visitDependency = (from: string[], name: string, optional: boolean) => {
    const workspacePath = workspaceByName.get(name);
    if (workspacePath !== undefined) {
      visitWorkspace(workspacePath);
      return;
    }
    const key = resolve(from, name);
    if (key === undefined) {
      // An optional dependency for a platform no one targets, or an optional
      // peer, is legitimately absent; anything else is a lockfile we misread.
      if (optional) return;
      throw new Error(
        `${name} (needed by ${from.join("/") || "root"}) is not in bun.lock`,
      );
    }
    const entry = lock.packages[key] as LockEntry;
    const meta = entry[2] ?? {};
    if (!matches(meta.os, [TARGET_OS]) || !matches(meta.cpu, TARGET_CPUS)) {
      return;
    }
    const existing = found.get(key);
    if (existing !== undefined) {
      if (existing.optional && !optional) existing.optional = false;
      return;
    }
    const id = entry[0];
    const at = id.lastIndexOf("@");
    found.set(key, {
      key,
      name: id.slice(0, at),
      version: id.slice(at + 1),
      optional,
    });
    for (const [child, childOptional] of dependencyNames(
      meta,
      meta.optionalPeers ?? [],
    )) {
      visitDependency(keyPath(key), child, optional || childOptional);
    }
  };

  const paths =
    roots === "all"
      ? Object.keys(lock.workspaces)
      : roots.map((root) => {
          if (lock.workspaces[root] === undefined) {
            throw new Error(`no workspace ${root} in bun.lock`);
          }
          return root;
        });
  for (const path of paths) visitWorkspace(path);
  return found;
}

/** Name and whether it may be missing, for every production edge. */
function dependencyNames(
  source: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  },
  optionalPeers: readonly string[],
): Array<[string, boolean]> {
  return [
    ...Object.keys(source.dependencies ?? {}).map(
      (name) => [name, false] as [string, boolean],
    ),
    ...Object.keys(source.optionalDependencies ?? {}).map(
      (name) => [name, true] as [string, boolean],
    ),
    // Bun installs peers; an optional one only if something else asks.
    ...Object.keys(source.peerDependencies ?? {}).map(
      (name) => [name, optionalPeers.includes(name)] as [string, boolean],
    ),
  ];
}

/** Whether an SPDX expression can be satisfied with PERMISSIVE ids alone. */
export function isPermissive(expression: string): boolean {
  // SPDX precedence: parentheses, then AND, then OR. Anything that does not
  // parse as an expression ("SEE LICENSE IN ...") is not permissive.
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const either = (): boolean => {
    let value = both();
    while (tokens[at] === "OR") {
      at += 1;
      const right = both();
      value = value || right;
    }
    return value;
  };
  const both = (): boolean => {
    let value = single();
    while (tokens[at] === "AND") {
      at += 1;
      const right = single();
      value = value && right;
    }
    return value;
  };
  const single = (): boolean => {
    const token = tokens[at++];
    if (token === "(") {
      const value = either();
      if (tokens[at++] !== ")") throw new SyntaxError(expression);
      return value;
    }
    if (token === undefined || [")", "AND", "OR", "WITH"].includes(token)) {
      throw new SyntaxError(expression);
    }
    // An exception changes the terms; that is a person's call.
    if (tokens[at] === "WITH") {
      at += 2;
      return false;
    }
    return PERMISSIVE.has(token);
  };
  try {
    const value = either();
    return at === tokens.length && value;
  } catch {
    return false;
  }
}

export function reviewFor(name: string, license: string): string | undefined {
  const review =
    REVIEWED[name] ??
    Object.entries(REVIEWED).find(
      ([pattern]) =>
        pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1)),
    )?.[1];
  return review?.license === license ? review.reason : undefined;
}

export type PackageInfo = {
  license: string;
  /** Verbatim NOTICE files the package ships, which Apache-2.0 §4(d) says to pass on. */
  notices: string[];
};

export type Row = {
  name: string;
  version: string;
  license: string;
  images: Image[];
  notices: string[];
};

export function licenseOf(manifest: {
  license?: unknown;
  licenses?: unknown;
}): string {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license && typeof (license as { type?: unknown }).type === "string") {
    return (license as { type: string }).type;
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (entry as { type?: unknown }).type)
      .filter((type): type is string => typeof type === "string");
    if (types.length > 0) return types.join(" OR ");
  }
  return "UNKNOWN";
}

/** Reads what the installed copy under node_modules says, if one is there. */
export function readInstalled(
  root: string,
  pkg: LockPackage,
): PackageInfo | undefined {
  const dir = join(
    root,
    "node_modules",
    ...keyPath(pkg.key).join("/node_modules/").split("/"),
  );
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `${pkg.key}: node_modules has ${manifest.version}, bun.lock ${pkg.version}; run bun install --frozen-lockfile`,
    );
  }
  const notices = readdirSync(dir)
    .filter((file) => /^notice(\.(md|txt))?$/i.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8").trim());
  return { license: licenseOf(manifest), notices };
}

async function fetchRegistry(pkg: LockPackage): Promise<PackageInfo> {
  const response = await fetch(
    `https://registry.npmjs.org/${pkg.name}/${pkg.version}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    throw new Error(
      `${pkg.name}@${pkg.version}: registry answered ${response.status}`,
    );
  }
  const license = licenseOf(await response.json());
  // The manifest does not list files, so a NOTICE cannot be seen from here.
  if (license.includes("Apache")) {
    throw new Error(
      `${pkg.name}@${pkg.version} is ${license} and not installed here; generate on a machine that installs it so its NOTICE is read`,
    );
  }
  return { license, notices: [] };
}

export function problemsOf(rows: readonly Row[]): string[] {
  return rows
    .filter(
      (row) => !isPermissive(row.license) && !reviewFor(row.name, row.license),
    )
    .map(
      (row) =>
        `${row.name}@${row.version} is ${row.license}: not in PERMISSIVE and not REVIEWED in scripts/third-party-notices.ts`,
    );
}

const BASE_IMAGE_SECTION = `## 베이스 이미지와 OS 패키지

세 이미지 모두 \`oven/bun:1.3.10\`(digest 고정, Dockerfile의 \`BUN_IMAGE\`) 위에 만든다. 이 베이스는 Debian 13(trixie) slim이다.

- **Bun 1.3.10** (\`/usr/local/bin/bun\`): MIT. Bun은 JavaScriptCore·WebKit(LGPL-2.1)을 정적으로 링크한다. 그 밖에 함께 링크된 라이브러리와 각 라이선스, LGPL에 따른 재링크 방법은 https://github.com/oven-sh/bun/blob/bun-v1.3.10/LICENSE.md 에 있다. Bun이 쓰는 WebKit 수정본의 소스는 https://github.com/oven-sh/webkit 이다.
- **Debian 패키지**: 각 패키지의 저작권·라이선스 전문은 이미지 안 \`/usr/share/doc/<패키지>/copyright\`에 있다. images.yml이 빌드한 이미지마다 설치된 모든 패키지에 이 파일이 있는지 확인한다. 소스는 https://sources.debian.org/ 와 https://snapshot.debian.org/ 에서 받을 수 있다.
- **Dockerfile이 추가로 설치하는 Debian 패키지**: control-host는 git(GPL-2.0)·tini(MIT), worker는 ca-certificates(MPL-2.0·GPL-2.0+)·git·tini·xfsprogs(GPL-2.0·LGPL-2.1)다. egress-proxy는 추가 패키지가 없다.
`;

export function render(rows: readonly Row[]): string {
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const flagged = rows.filter((row) => !isPermissive(row.license));
  const withNotices = rows.filter((row) => row.notices.length > 0);
  const lines = [
    "# 제3자 구성요소 고지",
    "",
    "배포 이미지(control-host·worker·egress-proxy)에 들어가는 제3자 구성요소와 그 라이선스다. 각 npm 패키지의 라이선스 전문은 이미지 안 `/app/node_modules/<패키지>/`에 패키지와 함께 들어 있다.",
    "",
    "이 파일은 `bun scripts/third-party-notices.ts`가 `bun.lock`에서 만든다. 손으로 고치지 않는다. CI의 `check (licenses)`가 `--check`로 최신인지 확인한다.",
    "",
    BASE_IMAGE_SECTION,
    "## 배포 조건이 붙은 구성요소",
    "",
    "허용 목록(MIT·Apache-2.0·BSD 계열·ISC 등) 밖의 라이선스다. 각각 스크립트의 `REVIEWED`에 검토 사유가 있다.",
    "",
    ...(flagged.length === 0
      ? ["없음."]
      : flagged.map(
          (row) =>
            `- \`${row.name}@${row.version}\` (${row.license}): ${reviewFor(row.name, row.license)}`,
        )),
    "",
    'Apache-2.0 패키지가 NOTICE 파일을 싣고 있으면 그 전문을 아래 "NOTICE 전문"에 옮긴다.',
    "",
    "## npm 패키지 (production closure)",
    "",
    "| 패키지 | 버전 | 라이선스 | 이미지 |",
    "|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${cell(row.name)} | ${cell(row.version)} | ${cell(row.license)} | ${row.images.join(", ")} |`,
    ),
    "",
    "## NOTICE 전문",
    "",
    ...(withNotices.length === 0
      ? ["없음.", ""]
      : withNotices.flatMap((row) => [
          `### ${row.name}@${row.version}`,
          "",
          "```text",
          ...row.notices.flatMap((notice, index) =>
            index === 0 ? [notice] : ["", notice],
          ),
          "```",
          "",
        ])),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The rows of a file `render` wrote, keyed by name@version. */
export function parseRows(markdown: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const line of markdown.split("\n")) {
    const match = line.match(/^\| (.+?) \| (\S+) \| (.+?) \| ([a-z, -]+) \|$/);
    if (!match || match[1] === "패키지") continue;
    const [, name, version, license, images] = match as unknown as string[];
    rows.set(`${name}@${version}`, {
      name: name as string,
      version: version as string,
      license: (license as string).replaceAll("\\|", "|"),
      images: (images as string).split(", ") as Image[],
      notices: [],
    });
  }
  return rows;
}

export async function collectRows(
  root: string,
  fallback: (pkg: LockPackage) => Promise<PackageInfo>,
): Promise<Row[]> {
  const lock = parseLockfile(readFileSync(join(root, "bun.lock"), "utf8"));
  const byId = new Map<string, Row>();
  for (const image of IMAGES) {
    for (const pkg of imageClosure(lock, image).values()) {
      const id = `${pkg.name}@${pkg.version}`;
      const known = byId.get(id);
      if (known !== undefined) {
        if (!known.images.includes(image)) known.images.push(image);
        continue;
      }
      const info = readInstalled(root, pkg) ?? (await fallback(pkg));
      byId.set(id, {
        name: pkg.name,
        version: pkg.version,
        ...info,
        images: [image],
      });
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name < b.name
        ? -1
        : 1,
  );
}

const OUTPUT = "THIRD_PARTY_NOTICES.md";

/**
 * Every name@version installed under a node_modules tree, nested ones
 * included. Workspace links are this repository's own code and skipped.
 */
export function installedPackages(nodeModules: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const candidates = entry.startsWith("@")
        ? readdirSync(join(dir, entry)).map((child) => join(dir, entry, child))
        : [join(dir, entry)];
      for (const candidate of candidates) {
        if (lstatSync(candidate).isSymbolicLink()) continue;
        const manifestPath = join(candidate, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        found.add(`${manifest.name}@${manifest.version}`);
        walk(join(candidate, "node_modules"));
      }
    }
  };
  walk(nodeModules);
  return [...found].sort();
}

async function main(argv: string[]): Promise<number> {
  const root = join(import.meta.dir, "..");
  const outputPath = join(root, OUTPUT);
  const [mode, ...rest] = argv;

  if (mode === "--verify") {
    const [image, appDir] = rest;
    if (!IMAGES.includes(image as Image) || appDir === undefined) {
      console.error("usage: third-party-notices.ts --verify <image> <app-dir>");
      return 2;
    }
    const listed = parseRows(readFileSync(outputPath, "utf8"));
    // Workspace packages are links to this repository's own code; a copy
    // instead of a link would still be ours.
    const held = installedPackages(join(appDir, "node_modules")).filter(
      (id) => !id.startsWith("@agent-platform/"),
    );
    const missing = held.filter(
      (id) => !listed.get(id)?.images.includes(image as Image),
    );
    for (const id of missing) {
      console.error(
        `${image} image holds ${id}, which ${OUTPUT} does not list for it`,
      );
    }
    console.log(
      `${image}: ${held.length} packages under ${appDir}/node_modules, ${missing.length} not in ${OUTPUT}`,
    );
    return missing.length === 0 ? 0 : 1;
  }

  const checking = mode === "--check";
  if (mode !== undefined && !checking) {
    console.error(
      "usage: third-party-notices.ts [--check | --verify <image> <app-dir>]",
    );
    return 2;
  }
  const committed = existsSync(outputPath)
    ? readFileSync(outputPath, "utf8")
    : "";
  const committedRows = parseRows(committed);
  const rows = await collectRows(root, async (pkg) => {
    if (!checking) return fetchRegistry(pkg);
    const row = committedRows.get(`${pkg.name}@${pkg.version}`);
    // A package the file does not name yet is drift, reported below.
    return { license: row?.license ?? "UNKNOWN", notices: [] };
  });
  const problems = problemsOf(rows);
  for (const problem of problems) console.error(problem);
  const next = render(rows);
  if (checking) {
    if (next !== committed) {
      const nextRows = parseRows(next);
      for (const id of nextRows.keys()) {
        if (!committedRows.has(id)) console.error(`+ ${id}`);
      }
      for (const id of committedRows.keys()) {
        if (!nextRows.has(id)) console.error(`- ${id}`);
      }
      console.error(
        `${OUTPUT} does not match bun.lock and node_modules; run \`bun scripts/third-party-notices.ts\` and commit the result`,
      );
      return 1;
    }
    console.log(`${OUTPUT} is current: ${rows.length} packages`);
    return problems.length === 0 ? 0 : 1;
  }
  if (problems.length > 0) return 1;
  writeFileSync(outputPath, next);
  console.log(`wrote ${OUTPUT}: ${rows.length} packages`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
