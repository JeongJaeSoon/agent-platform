import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reportedSourceDigest, sourceDigest } from "./source.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "egress-source-"));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe("sourceDigest", () => {
  test("does not depend on the order files were written in", () => {
    const a = tree({ "main.ts": "m", "proxy.ts": "p", "sub/x.ts": "x" });
    const b = tree({ "sub/x.ts": "x", "proxy.ts": "p", "main.ts": "m" });
    expect(sourceDigest(a)).toBe(sourceDigest(b));
  });

  test("changes when a byte of the running source changes", () => {
    const before = tree({ "main.ts": "m", "proxy.ts": "pipe" });
    const after = tree({ "main.ts": "m", "proxy.ts": "frame" });
    expect(sourceDigest(before)).not.toBe(sourceDigest(after));
  });

  test("changes when bytes move between a name and a file", () => {
    const a = tree({ "ab.ts": "c" });
    const b = tree({ "a.ts": "bc" });
    expect(sourceDigest(a)).not.toBe(sourceDigest(b));
  });

  test("ignores tests, test helpers and non-TypeScript files", () => {
    const base = tree({ "main.ts": "m" });
    const noisy = tree({
      "main.ts": "m",
      "main.test.ts": "t",
      "testing/pooled-client.ts": "c",
      "README.md": "r",
    });
    expect(sourceDigest(noisy)).toBe(sourceDigest(base));
  });

  test("covers the proxy's own src", () => {
    expect(sourceDigest(import.meta.dir)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("reportedSourceDigest", () => {
  const digest = "a".repeat(64);

  test("reads the digest a proxy puts on /healthz", () => {
    expect(reportedSourceDigest(`ok source=${digest}\n`)).toBe(digest);
  });

  test("is null for a proxy that reports none", () => {
    expect(reportedSourceDigest("ok\n")).toBeNull();
    expect(reportedSourceDigest(`ok source=${digest.slice(1)}\n`)).toBeNull();
  });
});
