import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_BUILDS,
  baseImageOf,
  CLAUDE_CODE_BUN,
  embeddedBunVersions,
  holderOf,
  imageClosure,
  isLicenseFile,
  isPermissive,
  type Lockfile,
  licenseOf,
  mentionsGpl,
  parseDebianSources,
  parseDpkgStatus,
  parseLockfile,
  parseRows,
  problemsOf,
  type Row,
  removedFrom,
  render,
  renderDebianSources,
  snapshotUrl,
} from "../scripts/third-party-notices.ts";

const root = join(import.meta.dir, "..");
const base = { bun: "1.3.10", digest: `sha256:${"0".repeat(64)}` };

// Shaped like bun.lock: workspaces by path, packages by hoisting key.
const lock: Lockfile = {
  workspaces: {
    "": { name: "root" },
    "apps/control-host": {
      name: "@agent-platform/control-host",
      dependencies: { "@agent-platform/storage": "workspace:*", hono: "4" },
    },
    "apps/worker": {
      name: "@agent-platform/worker",
      dependencies: { sdk: "1" },
    },
    "packages/storage": {
      name: "@agent-platform/storage",
      dependencies: { "@scope/a": "1" },
    },
  },
  packages: {
    "@agent-platform/control-host": [
      "@agent-platform/control-host@workspace:apps/control-host",
    ],
    "@agent-platform/storage": [
      "@agent-platform/storage@workspace:packages/storage",
    ],
    "@agent-platform/worker": ["@agent-platform/worker@workspace:apps/worker"],
    hono: ["hono@4.0.0", "", {}, "sha"],
    "@scope/a": ["@scope/a@1.0.0", "", { dependencies: { b: "2" } }, "sha"],
    // A second b that only @scope/a sees: the nested key wins over the hoisted.
    b: ["b@1.0.0", "", {}, "sha"],
    "@scope/a/b": ["b@2.0.0", "", { dependencies: { c: "1" } }, "sha"],
    c: ["c@1.0.0", "", {}, "sha"],
    sdk: [
      "sdk@1.0.0",
      "",
      {
        optionalDependencies: {
          "sdk-linux-x64": "1",
          "sdk-darwin-arm64": "1",
          "sdk-linux-riscv": "1",
        },
        peerDependencies: { zod: "4", "left-out": "1" },
        optionalPeers: ["left-out"],
      },
      "sha",
    ],
    "sdk-linux-x64": [
      "sdk-linux-x64@1.0.0",
      "",
      { os: "linux", cpu: "x64" },
      "sha",
    ],
    "sdk-darwin-arm64": [
      "sdk-darwin-arm64@1.0.0",
      "",
      { os: "darwin", cpu: "arm64" },
      "sha",
    ],
    "sdk-linux-riscv": [
      "sdk-linux-riscv@1.0.0",
      "",
      { os: "linux", cpu: "riscv64" },
      "sha",
    ],
    zod: ["zod@4.0.0", "", {}, "sha"],
    "not-windows": [
      "not-windows@1.0.0",
      "",
      { os: ["!win32"], cpu: "*" },
      "sha",
    ],
  },
};

const ids = (image: "control-host" | "worker" | "egress-proxy") =>
  [...imageClosure(lock, image).values()]
    .map((pkg) => `${pkg.name}@${pkg.version}`)
    .sort();

describe("image closure from bun.lock", () => {
  test("follows workspace dependencies and resolves nested keys before hoisted ones", () => {
    expect(ids("control-host")).toEqual([
      "@scope/a@1.0.0",
      "b@2.0.0",
      "c@1.0.0",
      "hono@4.0.0",
    ]);
  });

  test("the worker installs every workspace; linux x64/arm64 builds and required peers only", () => {
    expect(ids("worker")).toEqual([
      "@scope/a@1.0.0",
      "b@2.0.0",
      "c@1.0.0",
      "hono@4.0.0",
      "sdk-linux-x64@1.0.0",
      "sdk@1.0.0",
      "zod@4.0.0",
    ]);
  });

  test("the egress proxy installs nothing", () => {
    expect(ids("egress-proxy")).toEqual([]);
  });

  test("a required dependency missing from the lockfile is an error, not a gap", () => {
    const broken: Lockfile = {
      ...lock,
      packages: { ...lock.packages, c: undefined as never },
    };
    delete (broken.packages as Record<string, unknown>).c;
    expect(() => imageClosure(broken, "control-host")).toThrow(
      /c \(needed by @scope\/a\/b\) is not in bun.lock/,
    );
  });

  test("the real lockfile resolves for every image", () => {
    const real = parseLockfile(readFileSync(join(root, "bun.lock"), "utf8"));
    const controlHost = imageClosure(real, "control-host");
    const worker = imageClosure(real, "worker");
    // The Dockerfiles' own promises: the SDK only in the worker, nothing in
    // the proxy, and the worker a superset (it installs every workspace).
    const names = (closure: typeof worker) =>
      new Set([...closure.values()].map((pkg) => pkg.name));
    expect(names(worker).has("@anthropic-ai/claude-agent-sdk")).toBe(true);
    expect(names(controlHost).has("@anthropic-ai/claude-agent-sdk")).toBe(
      false,
    );
    for (const name of names(controlHost)) {
      expect(names(worker).has(name)).toBe(true);
    }
    expect(imageClosure(real, "egress-proxy").size).toBe(0);
  });
});

describe("license policy", () => {
  test("SPDX expressions", () => {
    expect(isPermissive("MIT")).toBe(true);
    expect(isPermissive("(MIT OR GPL-3.0)")).toBe(true);
    expect(isPermissive("MIT AND Apache-2.0")).toBe(true);
    expect(isPermissive("MIT AND GPL-2.0")).toBe(false);
    expect(isPermissive("LGPL-2.1")).toBe(false);
    expect(isPermissive("SEE LICENSE IN LICENSE.md")).toBe(false);
    expect(isPermissive("UNKNOWN")).toBe(false);
    // AND binds tighter than OR, and parentheses group: GPL-2.0 is required.
    expect(isPermissive("(MIT OR GPL-3.0) AND GPL-2.0")).toBe(false);
    expect(isPermissive("MIT OR GPL-3.0 AND GPL-2.0")).toBe(true);
    expect(isPermissive("GPL-2.0 AND (MIT OR ISC)")).toBe(false);
    expect(isPermissive("((MIT))")).toBe(true);
    expect(isPermissive("GPL-2.0 WITH Classpath-exception-2.0")).toBe(false);
    expect(isPermissive("MIT OR")).toBe(false);
    expect(isPermissive("(MIT")).toBe(false);
  });

  test("reads the legacy license shapes", () => {
    expect(licenseOf({ license: "ISC" })).toBe("ISC");
    expect(licenseOf({ license: { type: "MIT" } })).toBe("MIT");
    expect(
      licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    ).toBe("MIT OR Apache-2.0");
    expect(licenseOf({})).toBe("UNKNOWN");
  });

  const row = (name: string, license: string, version = "1.0.0"): Row => ({
    name,
    version,
    license,
    images: ["worker"],
    notices: [],
  });

  test("a copyleft or unknown license fails until it is reviewed", () => {
    expect(problemsOf([row("hono", "MIT")], base)).toEqual([]);
    expect(problemsOf([row("gpl-thing", "GPL-3.0")], base)).toEqual([
      "gpl-thing@1.0.0 is GPL-3.0: not in PERMISSIVE and not REVIEWED in scripts/third-party-notices.ts",
    ]);
    // Reviewed by name, and a platform family by prefix.
    expect(
      problemsOf(
        [
          row(
            "@anthropic-ai/claude-agent-sdk",
            "SEE LICENSE IN README.md",
            "0.3.270",
          ),
          row(
            "@anthropic-ai/claude-agent-sdk-linux-x64",
            "SEE LICENSE IN LICENSE.md",
          ),
        ],
        base,
      ),
    ).toEqual([]);
    // A review covers the license it read; new terms need a new one.
    expect(
      problemsOf(
        [row("@anthropic-ai/claude-agent-sdk", "GPL-3.0", "0.3.270")],
        base,
      ),
    ).toHaveLength(1);
  });

  // 94S-375: what the notices say about Bun and the bundled Claude Code is
  // tied to a version, so a bump waits for someone to read the new one.
  test("a Bun or Agent SDK version without its pinned build fails", () => {
    expect(problemsOf([], { ...base, bun: "9.9.9" })).toEqual([
      "Bun 9.9.9 (the Dockerfiles' BUN_IMAGE) has no BUN_BUILDS entry in scripts/third-party-notices.ts",
    ]);
    expect(
      problemsOf(
        [
          row(
            "@anthropic-ai/claude-agent-sdk",
            "SEE LICENSE IN README.md",
            "9.9.9",
          ),
        ],
        base,
      ),
    ).toEqual([
      "@anthropic-ai/claude-agent-sdk@9.9.9 has no CLAUDE_CODE_BUN entry in scripts/third-party-notices.ts",
    ]);
  });

  test("the notices name the Bun build and the source of its LGPL parts", () => {
    const text = render(
      [
        row(
          "@anthropic-ai/claude-agent-sdk",
          "SEE LICENSE IN README.md",
          "0.3.270",
        ),
      ],
      base,
    );
    const build = BUN_BUILDS["1.3.10"];
    expect(text).toContain(`oven/bun:1.3.10@${base.digest}`);
    expect(text).toContain(`commit \`${build?.revision}\``);
    expect(text).toContain(`oven-sh/WebKit/tree/${build?.webkit}`);
    expect(text).toContain(`oven-sh/tinycc/tree/${build?.tinycc}`);
    expect(text).toContain("oven-sh/bun/tree/bun-v1.3.10");
    expect(text).toContain(
      `Bun ${CLAUDE_CODE_BUN["0.3.270"]} 런타임을 내장한다`,
    );
    // Only an image list with the SDK gets the Claude Code section.
    expect(render([row("hono", "MIT")], base)).not.toContain("Claude Code");
  });

  test("the file round-trips: every row render writes, parseRows reads back", () => {
    const rows: Row[] = [
      { ...row("a", "MIT"), images: ["control-host", "worker"] },
      {
        ...row("b", "Apache-2.0"),
        notices: ["Copyright b\nNOTICE body"],
      },
    ];
    const text = render(rows, base);
    expect(text).toContain(
      "### b@1.0.0\n\n```text\nCopyright b\nNOTICE body\n```",
    );
    const parsed = parseRows(text);
    expect([...parsed.keys()]).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(parsed.get("a@1.0.0")?.images).toEqual(["control-host", "worker"]);
    expect(parsed.get("b@1.0.0")?.license).toBe("Apache-2.0");
    expect(text).toContain("## 라이선스 파일이 없는 npm 패키지\n\n없음.");
  });

  // A package without its own license file gets its text from the notices,
  // and --check reads the holder back for a build this machine lacks.
  test("a package without a license file: holder listed, text carried", () => {
    const rows: Row[] = [
      { ...row("pgpass", "MIT"), holder: "Hannes Hörl, https://x/pgpass" },
      { ...row("drizzle-orm", "Apache-2.0"), holder: "Drizzle Team" },
      row("hono", "MIT"),
    ];
    const text = render(rows, base);
    expect(text).toContain(
      "- `pgpass@1.0.0` (MIT): Hannes Hörl, https://x/pgpass",
    );
    expect(text).toContain(
      "Copyright (c) <저작권자>\n\nPermission is hereby granted",
    );
    expect(text).toContain("/usr/share/common-licenses/Apache-2.0");
    const parsed = parseRows(text);
    expect(parsed.get("pgpass@1.0.0")?.holder).toBe(
      "Hannes Hörl, https://x/pgpass",
    );
    expect(parsed.get("hono@1.0.0")?.holder).toBeUndefined();
    expect(problemsOf(rows, base)).toEqual([]);
    expect(
      problemsOf([{ ...row("isc-thing", "ISC"), holder: "someone" }], base),
    ).toEqual([
      "isc-thing@1.0.0 ships no license file and the notices carry no ISC text; add it to CARRIED_TEXTS and render in scripts/third-party-notices.ts",
    ]);
  });

  test("license files and holders", () => {
    for (const file of [
      "LICENSE",
      "LICENSE.md",
      "license.txt",
      "LICENSE-MIT",
      "LICENCE",
      "COPYING",
    ]) {
      expect(isLicenseFile(file)).toBe(true);
    }
    for (const file of ["README.md", "licenses.json", "NOTICE"]) {
      expect(isLicenseFile(file)).toBe(false);
    }
    // No maintainer address is republished.
    expect(
      holderOf({
        author: "Hannes Hörl <hannes@example.com> (https://h.example)",
        repository: { url: "git+https://github.com/hoegaarden/pgpass.git" },
      }),
    ).toBe("Hannes Hörl, https://github.com/hoegaarden/pgpass.git");
    expect(holderOf({ author: { name: "Drizzle Team" } })).toBe("Drizzle Team");
    expect(holderOf({ repository: "https://github.com/oven-sh/bun" })).toBe(
      "저작자 표기 없음, https://github.com/oven-sh/bun",
    );
  });
});

describe("base image pins", () => {
  test("the Dockerfiles' BUN_IMAGE", () => {
    const pinned = baseImageOf(
      readFileSync(join(root, "apps/worker/Dockerfile"), "utf8"),
    );
    expect(pinned.bun).toBe("1.3.10");
    expect(pinned.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => baseImageOf("FROM oven/bun:1.3.10")).toThrow();
  });

  test("the Bun running this test is a pinned build", () => {
    // CI and the images run the same Bun; its revision is the one named.
    expect(BUN_BUILDS[Bun.version]?.revision).toBe(Bun.revision);
  });
});

describe("Debian corresponding source (94S-375)", () => {
  const status = [
    "Package: libc6",
    "Status: install ok installed",
    "Architecture: amd64",
    "Source: glibc",
    "Version: 2.41-12",
    "Description: GNU C Library",
    " Continuation: not a field",
    "",
    "Package: libgcc-s1",
    "Status: install ok installed",
    "Source: gcc-14 (14.2.0-19)",
    "Version: 14.2.0-19+b1",
    "",
    "Package: libc-bin",
    "Status: install ok installed",
    "Source: glibc",
    "Version: 2.41-12",
    "",
    "Package: tini",
    "Status: install ok installed",
    "Version: 0.19.0-1+b3",
    "Built-Using: musl (= 1.2.5-3), glibc (= 2.41-12)",
    "",
    "Package: removed",
    "Status: deinstall ok config-files",
    "Version: 1.0",
    "",
    "Package: broken",
    "Status: install reinstreq half-installed",
    "Version: 1.0",
    "",
  ].join("\n");

  test("installed packages with the source they were built from", () => {
    expect(parseDpkgStatus(status)).toEqual([
      {
        name: "libc6",
        version: "2.41-12",
        source: "glibc",
        sourceVersion: "2.41-12",
        builtUsing: [],
      },
      // A binNMU: the source version is the one in parentheses.
      {
        name: "libgcc-s1",
        version: "14.2.0-19+b1",
        source: "gcc-14",
        sourceVersion: "14.2.0-19",
        builtUsing: [],
      },
      {
        name: "libc-bin",
        version: "2.41-12",
        source: "glibc",
        sourceVersion: "2.41-12",
        builtUsing: [],
      },
      // No Source field: the package is its own source, version included.
      {
        name: "tini",
        version: "0.19.0-1+b3",
        source: "tini",
        sourceVersion: "0.19.0-1+b3",
        // Statically incorporated sources are corresponding source too.
        builtUsing: [
          { source: "musl", version: "1.2.5-3" },
          { source: "glibc", version: "2.41-12" },
        ],
      },
    ]);
  });

  test("one row per source package, with its snapshot.debian.org address", () => {
    const text = renderDebianSources(
      parseDpkgStatus(status),
      (pkg) => pkg.source === "glibc",
    );
    expect(text).toContain("source package 4개, 바이너리 패키지 4개.");
    const rows = text
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| source"));
    expect(rows).toEqual([
      "| gcc-14 | 14.2.0-19 | libgcc-s1 |  | https://snapshot.debian.org/package/gcc-14/14.2.0-19/ |",
      "| glibc | 2.41-12 | libc-bin, libc6, tini (Built-Using) | 예 | https://snapshot.debian.org/package/glibc/2.41-12/ |",
      "| musl | 1.2.5-3 | tini (Built-Using) |  | https://snapshot.debian.org/package/musl/1.2.5-3/ |",
      "| tini | 0.19.0-1+b3 | tini |  | https://snapshot.debian.org/package/tini/0.19.0-1%2Bb3/ |",
    ]);
    // What --snapshot-check reads back.
    expect(parseDebianSources(text)).toEqual([
      { source: "gcc-14", version: "14.2.0-19" },
      { source: "glibc", version: "2.41-12" },
      { source: "musl", version: "1.2.5-3" },
      { source: "tini", version: "0.19.0-1+b3" },
    ]);
  });

  test("epochs and plus signs are escaped the way snapshot.debian.org takes them", () => {
    expect(snapshotUrl("openssl", "3.5.1-1+deb13u1")).toBe(
      "https://snapshot.debian.org/package/openssl/3.5.1-1%2Bdeb13u1/",
    );
    expect(snapshotUrl("shadow", "1:4.17.4-2")).toBe(
      "https://snapshot.debian.org/package/shadow/1%3A4.17.4-2/",
    );
  });

  test("GPL-family mentions in a copyright file", () => {
    expect(mentionsGpl("License: GPL-2+")).toBe(true);
    expect(mentionsGpl("License: LGPL-2.1+")).toBe(true);
    expect(mentionsGpl("GNU Lesser General Public License")).toBe(true);
    expect(mentionsGpl("License: MIT")).toBe(false);
  });
});

describe("the Bun inside the Claude Code executable", () => {
  test("reads every Bun v<x.y.z> the binary names", () => {
    const binary = Buffer.from(
      "\0\0Bun v1.4.3 (linux x64)\0Bun v1.4.30\0Bun v1.4.3\0Bun vnext\0",
      "latin1",
    );
    expect(embeddedBunVersions(binary)).toEqual(["1.4.3", "1.4.30"]);
    expect(embeddedBunVersions(Buffer.from("no runtime here"))).toEqual([]);
  });
});

describe("packages a Dockerfile deletes", () => {
  test("the worker's musl builds are in the closure but not the image", () => {
    expect(
      removedFrom("worker", "@anthropic-ai/claude-agent-sdk-linux-x64-musl"),
    ).toBe(true);
    expect(
      removedFrom("worker", "@anthropic-ai/claude-agent-sdk-linux-x64"),
    ).toBe(false);
    expect(
      removedFrom(
        "control-host",
        "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      ),
    ).toBe(false);
    const listed = parseRows(
      readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    );
    expect([...listed.keys()].filter((id) => id.includes("-musl@"))).toEqual(
      [],
    );
  });
});
