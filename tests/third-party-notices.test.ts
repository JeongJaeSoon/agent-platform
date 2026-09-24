import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  imageClosure,
  isPermissive,
  type Lockfile,
  licenseOf,
  parseLockfile,
  parseRows,
  problemsOf,
  type Row,
  render,
} from "../scripts/third-party-notices.ts";

const root = join(import.meta.dir, "..");

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
  });

  test("reads the legacy license shapes", () => {
    expect(licenseOf({ license: "ISC" })).toBe("ISC");
    expect(licenseOf({ license: { type: "MIT" } })).toBe("MIT");
    expect(
      licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    ).toBe("MIT OR Apache-2.0");
    expect(licenseOf({})).toBe("UNKNOWN");
  });

  const row = (name: string, license: string): Row => ({
    name,
    version: "1.0.0",
    license,
    images: ["worker"],
    notices: [],
  });

  test("a copyleft or unknown license fails until it is reviewed", () => {
    expect(problemsOf([row("hono", "MIT")])).toEqual([]);
    expect(problemsOf([row("gpl-thing", "GPL-3.0")])).toEqual([
      "gpl-thing@1.0.0 is GPL-3.0: not in PERMISSIVE and not REVIEWED in scripts/third-party-notices.ts",
    ]);
    // Reviewed by name, and a platform family by prefix.
    expect(
      problemsOf([
        row("@anthropic-ai/claude-agent-sdk", "SEE LICENSE IN README.md"),
        row(
          "@anthropic-ai/claude-agent-sdk-linux-x64",
          "SEE LICENSE IN LICENSE.md",
        ),
      ]),
    ).toEqual([]);
  });

  test("the file round-trips: every row render writes, parseRows reads back", () => {
    const rows: Row[] = [
      { ...row("a", "MIT"), images: ["control-host", "worker"] },
      {
        ...row("b", "Apache-2.0"),
        notices: ["Copyright b\nNOTICE body"],
      },
    ];
    const text = render(rows);
    expect(text).toContain(
      "### b@1.0.0\n\n```text\nCopyright b\nNOTICE body\n```",
    );
    const parsed = parseRows(text);
    expect([...parsed.keys()]).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(parsed.get("a@1.0.0")?.images).toEqual(["control-host", "worker"]);
    expect(parsed.get("b@1.0.0")?.license).toBe("Apache-2.0");
  });
});
