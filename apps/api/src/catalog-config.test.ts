import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_DIR,
  loadSessionCatalog,
  PROFILES_FILE,
  REPOSITORIES_FILE,
  readCatalogConfig,
  type SecretReader,
} from "./catalog-config.ts";
import { heartbeatTtlMsFromEnv } from "./lease-config.ts";

const PROFILES = `profiles:
  claude-coding-v1:
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
  from-secrets:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        secret_id: agent-platform/provider
`;
const REPOSITORIES = `repositories:
  sample-app:
    url: http://gitea:3000/agent/sample-app.git
    branch: main
    profiles: [claude-coding-v1, from-secrets]
`;
const SECRET_VALUE = "value-from-secrets-manager";
const ENV_VALUE = "value-from-environment";

let root: string;
let count = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "catalog-config-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function dirWith(
  files: Partial<Record<string, string>> = {},
): Promise<string> {
  const dir = join(root, String(count++));
  const contents: Record<string, string | undefined> = {
    [PROFILES_FILE]: PROFILES,
    [REPOSITORIES_FILE]: REPOSITORIES,
    ...files,
  };
  await Bun.write(join(dir, ".keep"), "");
  for (const [name, text] of Object.entries(contents)) {
    if (text !== undefined) await writeFile(join(dir, name), text);
  }
  return dir;
}

const secrets: SecretReader = async (id) =>
  id === "agent-platform/provider" ? SECRET_VALUE : undefined;

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the load to fail");
}

describe("loadSessionCatalog", () => {
  test("resolves both kinds of reference and keeps where each came from", async () => {
    const catalog = await loadSessionCatalog({
      dir: await dirWith(),
      env: { PROVIDER_KEY: ENV_VALUE },
      readSecret: secrets,
    });
    expect(catalog.profiles["claude-coding-v1"]?.provider.auth).toEqual({
      kind: "api_key",
      value: ENV_VALUE,
      ref: { value_env: "PROVIDER_KEY" },
    });
    expect(catalog.profiles["from-secrets"]?.provider.auth).toEqual({
      kind: "api_key",
      value: SECRET_VALUE,
      ref: { secret_id: "agent-platform/provider" },
    });
    expect(catalog.repositories["sample-app"]?.profiles).toEqual([
      "claude-coding-v1",
      "from-secrets",
    ]);
  });

  test("reads each secret once however many profiles share it", async () => {
    const reads: string[] = [];
    const twice = PROFILES.replace(
      "value_env: PROVIDER_KEY",
      "secret_id: agent-platform/provider",
    );
    await loadSessionCatalog({
      dir: await dirWith({ [PROFILES_FILE]: twice }),
      env: {},
      readSecret: async (id) => {
        reads.push(id);
        return SECRET_VALUE;
      },
    });
    expect(reads).toEqual(["agent-platform/provider"]);
  });

  test("a missing or unreadable secret names the profile and the reference, never a value", async () => {
    const missing = await failure(
      loadSessionCatalog({
        dir: await dirWith(),
        env: { PROVIDER_KEY: ENV_VALUE },
        readSecret: async () => undefined,
      }),
    );
    expect(missing).toBe(
      "profiles.from-secrets.provider.auth.secret_id: agent-platform/provider is not set",
    );
    const thrown = await failure(
      loadSessionCatalog({
        dir: await dirWith(),
        env: { PROVIDER_KEY: ENV_VALUE },
        readSecret: async () => {
          const error = new Error(`denied while reading ${SECRET_VALUE}`);
          error.name = "AccessDeniedException";
          throw error;
        },
      }),
    );
    expect(thrown).toBe(
      "profiles.from-secrets.provider.auth.secret_id: agent-platform/provider could not be read (AccessDeniedException)",
    );
    expect(thrown).not.toContain(SECRET_VALUE);
  });

  test("an empty environment value is not a credential", async () => {
    expect(
      await failure(
        loadSessionCatalog({
          dir: await dirWith(),
          env: { PROVIDER_KEY: "" },
          readSecret: secrets,
        }),
      ),
    ).toBe(
      "profiles.claude-coding-v1.provider.auth.value_env: PROVIDER_KEY is not set",
    );
  });

  test("refuses to start while the retired SESSION_CATALOG_JSON is still set", async () => {
    expect(
      await failure(
        loadSessionCatalog({
          dir: await dirWith(),
          env: { PROVIDER_KEY: ENV_VALUE, SESSION_CATALOG_JSON: "{}" },
          readSecret: secrets,
        }),
      ),
    ).toContain("SESSION_CATALOG_JSON is no longer read");
  });
});

describe("readCatalogConfig", () => {
  test("a missing file, bad YAML or a stray top-level key names the file", async () => {
    const noRepositories = await dirWith({ [REPOSITORIES_FILE]: undefined });
    expect(await failure(readCatalogConfig(noRepositories))).toBe(
      `${join(noRepositories, REPOSITORIES_FILE)} is missing`,
    );
    const broken = await dirWith({ [PROFILES_FILE]: "profiles: [unclosed" });
    expect(await failure(readCatalogConfig(broken))).toStartWith(
      `${join(broken, PROFILES_FILE)} is not valid YAML: `,
    );
    for (const text of [
      `${PROFILES}repositories: {}\n`,
      "profile:\n  a: {}\n",
      "- profiles\n",
      "",
    ]) {
      const dir = await dirWith({ [PROFILES_FILE]: text });
      expect(await failure(readCatalogConfig(dir))).toBe(
        `${join(dir, PROFILES_FILE)} must hold exactly one top-level key: profiles`,
      );
    }
  });

  test("a key defined twice is refused, not resolved to the last one", async () => {
    const dir = await dirWith({
      [PROFILES_FILE]: PROFILES.replace(
        "  from-secrets:",
        `  claude-coding-v1:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-opus-5-5
    tools: [Read]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: https://elsewhere.invalid
      auth:
        kind: api_key
        value_env: OTHER_KEY
  from-secrets:`,
      ),
    });
    expect(await failure(readCatalogConfig(dir))).toStartWith(
      `${join(dir, PROFILES_FILE)} is not valid YAML: Map keys must be unique`,
    );
  });

  test("an invalid profile stops the load with its path", async () => {
    const dir = await dirWith({
      [PROFILES_FILE]: PROFILES.replace(
        "permission_mode: default",
        "permission_mode: yolo",
      ),
    });
    expect(await failure(readCatalogConfig(dir))).toStartWith(
      `Catalog config in ${dir} is invalid: profiles.claude-coding-v1.permission_mode: `,
    );
  });

  test("the example config shipped in the repository loads", async () => {
    const config = await readCatalogConfig(DEFAULT_CONFIG_DIR);
    expect(Object.keys(config.profiles).length).toBeGreaterThan(0);
    for (const repository of Object.values(config.repositories)) {
      for (const id of repository.profiles) {
        expect(Object.hasOwn(config.profiles, id)).toBe(true);
      }
    }
  });
});

describe("heartbeatTtlMsFromEnv", () => {
  test("unset is the platform default; a positive number is seconds", () => {
    expect(heartbeatTtlMsFromEnv(undefined)).toBe(30_000);
    expect(heartbeatTtlMsFromEnv("45")).toBe(45_000);
    expect(heartbeatTtlMsFromEnv("0.5")).toBe(500);
  });

  test("anything else stops the API instead of becoming the default", () => {
    expect(heartbeatTtlMsFromEnv("86400")).toBe(86_400_000);
    for (const value of [
      "",
      " ",
      "0",
      "-5",
      "abc",
      "Infinity",
      "NaN",
      "86401",
      "1e308",
    ]) {
      expect(() => heartbeatTtlMsFromEnv(value)).toThrow(
        /^HEARTBEAT_TTL_SEC must be a positive number of seconds/,
      );
    }
  });
});
