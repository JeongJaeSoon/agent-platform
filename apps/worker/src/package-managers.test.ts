import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PACKAGE_MANAGER_FILES,
  packageManagerFiles,
  writePackageManagerConfig,
} from "./package-managers.ts";

const ROUTE = "http://egress-proxy:3129";
const TOKEN = "wek_attempt-token";

describe("packageManagerFiles", () => {
  const files = packageManagerFiles(ROUTE, TOKEN);

  test("npm reads the route as its registry with the token as a bearer", () => {
    expect(files.npm).toBe(
      [
        "registry=http://egress-proxy:3129/packages/npm/",
        "//egress-proxy:3129/packages/npm/:_authToken=wek_attempt-token",
        "",
      ].join("\n"),
    );
  });

  test("Bundler mirrors rubygems.org to the route", () => {
    expect(files.bundler).toContain(
      'BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG/: "http://werft:wek_attempt-token@egress-proxy:3129/packages/rubygems"',
    );
  });

  test("Go has one proxy and no direct, and its checksum database goes through the route", () => {
    const env = Object.fromEntries(
      files.go
        .trim()
        .split("\n")
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    expect(env).toEqual({
      GOPROXY: "http://werft:wek_attempt-token@egress-proxy:3129/packages/go",
      GOSUMDB:
        "sum.golang.org http://werft:wek_attempt-token@egress-proxy:3129/packages/gosum",
      GOFLAGS: "-mod=readonly",
    });
    expect(env.GOPROXY).not.toContain(",");
    expect(env.GOPROXY).not.toContain("|");
    expect(Object.keys(env)).not.toContain("GONOSUMDB");
    expect(Object.keys(env)).not.toContain("GOPRIVATE");
    expect(Object.keys(env)).not.toContain("GONOSUMCHECK");
  });

  test("a token that would break a URL is escaped in the userinfo", () => {
    expect(packageManagerFiles(ROUTE, "a@b/c").go).toContain(
      "http://werft:a%40b%2Fc@egress-proxy:3129/packages/go",
    );
  });
});

describe("writePackageManagerConfig", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "package-managers-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes each file under HOME, readable by the worker alone", async () => {
    await writePackageManagerConfig(home, ROUTE, TOKEN);
    for (const relative of Object.values(PACKAGE_MANAGER_FILES)) {
      const path = join(home, relative);
      expect(await readFile(path, "utf8")).toContain(TOKEN);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("a claim with no packages token leaves no configuration behind", async () => {
    await writePackageManagerConfig(home, ROUTE, TOKEN);
    await writePackageManagerConfig(home, ROUTE, undefined);
    for (const relative of Object.values(PACKAGE_MANAGER_FILES)) {
      expect(await Bun.file(join(home, relative)).exists()).toBe(false);
    }
  });
});
