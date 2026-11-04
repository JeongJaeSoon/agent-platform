import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTIONS_FILE,
  dirIsEmpty,
  PROFILES_FILE,
  REPOSITORIES_FILE,
  readCatalogConfig,
  readConnections,
  readSeedProfiles,
} from "./settings-from-dir.ts";

const PROFILES = `profiles:
  coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read, Edit]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: PROVIDER_KEY
`;
const REPOSITORIES = `repositories:
  sample-app:
    url: http://fake-git:3000/agent/sample-app.git
    branch: main
    profiles: [coding]
`;
const CONNECTIONS = `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    auth:
      kind: api_key
      value_env: PROVIDER_KEY
`;

let root: string;
let count = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-from-dir-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function dirWith(
  files: Partial<Record<string, string>> = {},
): Promise<string> {
  const dir = join(root, String(count++));
  await mkdir(dir);
  const contents: Record<string, string | undefined> = {
    [PROFILES_FILE]: PROFILES,
    [REPOSITORIES_FILE]: REPOSITORIES,
    [CONNECTIONS_FILE]: CONNECTIONS,
    ...files,
  };
  for (const [name, text] of Object.entries(contents)) {
    if (text !== undefined) await writeFile(join(dir, name), text);
  }
  return dir;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the read to fail");
}

async function readCatalog(dir: string) {
  const config = await readCatalogConfig(dir);
  return { ...config, profiles: await readSeedProfiles(dir, config) };
}

describe("the old catalog directory", () => {
  test("a missing file, bad YAML or a stray top-level key names the file", async () => {
    const noRepositories = await dirWith({ [REPOSITORIES_FILE]: undefined });
    expect(await failure(readCatalogConfig(noRepositories))).toBe(
      `${join(noRepositories, REPOSITORIES_FILE)} is missing`,
    );
    const broken = await dirWith({ [PROFILES_FILE]: "profiles: [unclosed" });
    expect(await failure(readCatalog(broken))).toStartWith(
      `${join(broken, PROFILES_FILE)} is not valid YAML: `,
    );
    for (const text of [
      `${PROFILES}repositories: {}\n`,
      "profile:\n  a: {}\n",
      "- profiles\n",
      "",
    ]) {
      const dir = await dirWith({ [PROFILES_FILE]: text });
      expect(await failure(readCatalog(dir))).toBe(
        `${join(dir, PROFILES_FILE)} must hold exactly one top-level key: profiles`,
      );
    }
  });

  test("without profiles.yaml there is nothing to seed and the repositories still load", async () => {
    const config = await readCatalog(
      await dirWith({ [PROFILES_FILE]: undefined }),
    );
    expect(config.profiles).toEqual({});
    expect(Object.keys(config.repositories)).toEqual(["sample-app"]);
  });

  test("profiles.yaml is never part of the catalog itself, only the seed", async () => {
    const dir = await dirWith();
    expect((await readCatalogConfig(dir)).profiles).toEqual({});
    expect(Object.keys((await readCatalog(dir)).profiles)).toEqual(["coding"]);
  });

  test("a directory without connections.yaml is refused, naming the file", async () => {
    const dir = await dirWith({ [CONNECTIONS_FILE]: undefined });
    expect(await failure(readConnections(dir))).toBe(
      `${join(dir, CONNECTIONS_FILE)} is missing`,
    );
  });

  test("a key defined twice is refused, not resolved to the last one", async () => {
    const dir = await dirWith({
      [PROFILES_FILE]: PROFILES.replace(
        "    model: claude-sonnet-5\n",
        "    model: claude-sonnet-5\n    model: claude-opus-5-5\n",
      ),
    });
    expect(await failure(readCatalog(dir))).toStartWith(
      `${join(dir, PROFILES_FILE)} is not valid YAML: Map keys must be unique`,
    );
  });

  test("an invalid profile stops the read with its path", async () => {
    const dir = await dirWith({
      [PROFILES_FILE]: PROFILES.replace(
        "permission_mode: default",
        "permission_mode: yolo",
      ),
    });
    expect(await failure(readCatalog(dir))).toStartWith(
      `Catalog config in ${dir} is invalid: profiles.coding.permission_mode: `,
    );
  });

  test("a directory holding only volume bookkeeping counts as empty", async () => {
    const dir = join(root, "kube");
    await mkdir(join(dir, "..2026_11_04"), { recursive: true });
    expect(await dirIsEmpty(dir)).toBe(true);
    expect(await dirIsEmpty(join(root, "absent"))).toBe(true);
    expect(await dirIsEmpty(await dirWith())).toBe(false);
  });
});
