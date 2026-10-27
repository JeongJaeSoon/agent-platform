import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  profileFingerprint,
  profilePinned,
  repositoryModeOf,
  resolveSessionCatalog,
} from "@werft-ai/platform";
import {
  ALLOW_UNATTENDED_SETTING,
  DEFAULT_CONFIG_DIR,
  installedRuntimes,
  loadCatalogConfig,
  loadSessionCatalog,
  optInProfiles,
  PROFILES_FILE,
  REPOSITORIES_FILE,
  readCatalogConfig,
  type SecretReader,
  unattendedProfiles,
} from "./catalog-config.ts";

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

  test("an unreadable secret names the endpoint it was read from", async () => {
    const thrown = await failure(
      loadSessionCatalog({
        dir: await dirWith(),
        env: {
          PROVIDER_KEY: ENV_VALUE,
          AWS_ENDPOINT_URL_SECRETS_MANAGER: "http://secrets:4566",
        },
        readSecret: async () => {
          const error = new Error("getaddrinfo ENOTFOUND secrets");
          error.name = "DNSException";
          throw error;
        },
      }),
    );
    expect(thrown).toBe(
      "profiles.from-secrets.provider.auth.secret_id: agent-platform/provider could not be read from http://secrets:4566 (DNSException)",
    );
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

describe("unattended permission modes", () => {
  const bypass = PROFILES.replace(
    "tools: [Read]\n    permission_mode: default",
    "tools: [Read]\n    permission_mode: bypassPermissions",
  );

  test("a profile that skips approval stops the load until the installation allows it", async () => {
    expect(bypass).not.toBe(PROFILES);
    const message = await failure(
      loadSessionCatalog({
        dir: await dirWith({ [PROFILES_FILE]: bypass }),
        env: { PROVIDER_KEY: ENV_VALUE },
        readSecret: secrets,
      }),
    );
    expect(message).toContain("from-secrets");
    expect(message).toContain(`${ALLOW_UNATTENDED_SETTING}=true`);
    expect(message).not.toContain("claude-coding-v1");
  });

  test("anything but the literal true keeps it refused", async () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      await failure(
        loadSessionCatalog({
          dir: await dirWith({ [PROFILES_FILE]: bypass }),
          env: { PROVIDER_KEY: ENV_VALUE, [ALLOW_UNATTENDED_SETTING]: value },
          readSecret: secrets,
        }),
      );
    }
  });

  test("with the switch on, the profile loads with its mode", async () => {
    const catalog = await loadSessionCatalog({
      dir: await dirWith({ [PROFILES_FILE]: bypass }),
      env: { PROVIDER_KEY: ENV_VALUE, [ALLOW_UNATTENDED_SETTING]: "true" },
      readSecret: secrets,
    });
    expect(catalog.profiles["from-secrets"]?.permission_mode).toBe(
      "bypassPermissions",
    );
    expect(unattendedProfiles(catalog)).toEqual(["from-secrets"]);
  });

  test("an auto profile loads without the switch: its classifier still judges each call", async () => {
    const auto = PROFILES.replace(
      "tools: [Read]\n    permission_mode: default",
      "tools: [Read]\n    permission_mode: auto",
    );
    expect(auto).not.toBe(PROFILES);
    const catalog = await loadSessionCatalog({
      dir: await dirWith({ [PROFILES_FILE]: auto }),
      env: { PROVIDER_KEY: ENV_VALUE },
      readSecret: secrets,
    });
    expect(catalog.profiles["from-secrets"]?.permission_mode).toBe("auto");
    expect(unattendedProfiles(catalog)).toEqual(["from-secrets"]);
    expect(optInProfiles(catalog)).toEqual([]);
  });
});

describe("installed runtimes", () => {
  test("pass every profile shipped in the repository", async () => {
    for (const dir of [
      ".",
      "fake-model",
      "local-model",
      "fake-model-unattended",
    ]) {
      const config = await readCatalogConfig(join(DEFAULT_CONFIG_DIR, dir));
      expect(Object.keys(config.profiles).length).toBeGreaterThan(0);
      installedRuntimes.assertProfiles(config.profiles);
    }
  });

  test("the default catalogs carry an auto base and start without the installation's opt-in", async () => {
    const expected: Record<string, string[]> = {
      ".": ["claude-coding-real-auto"],
      "fake-model": ["claude-coding-auto"],
      "local-model": [],
    };
    for (const [dir, auto] of Object.entries(expected)) {
      const config = await loadCatalogConfig({
        dir: join(DEFAULT_CONFIG_DIR, dir),
        env: {},
      });
      expect(unattendedProfiles(config)).toEqual(auto);
      expect(optInProfiles(config)).toEqual([]);
      for (const id of auto) {
        expect(config.repositories["sample-app"]?.profiles).toContain(id);
      }
    }
  });

  test("a shipped profile keeps the fingerprint main gave it, and an auto base is the same profile in every example", async () => {
    // Computed on main at 304c2713: sessions and releases pin these.
    const onMain: Record<string, Record<string, string>> = {
      ".": {
        "claude-coding-real":
          "sha256:9b0f3cfac118121bb700fa88ba6d7b418064520a82f4baa9769e2c55aa954790",
      },
      "fake-model": {
        "claude-coding-local":
          "sha256:ce5cd0ec2659ff5df68d461bac93fec5cf45a362aeac483de0df4d1fe44b4261",
        general:
          "sha256:573de23784b416dec3ac0d9922f0c833ef5f308752716f9f8503b9d6430d194f",
      },
      "local-model": {
        "local-ollama":
          "sha256:719a7af6b2f1ec7710965e57e021d8d1d558cc3043866d518de09aca8894ec4b",
        "local-litellm":
          "sha256:d342569f22e036620a11708b4f0247d2784577bc62c0caf556a0ecb2073f682a",
      },
      "fake-model-unattended": {
        "claude-coding-auto":
          "sha256:fa3ea8136562b7b2984deffcba6d5e6ea42df9dd366d364978f6e223d858633a",
        "claude-coding-bypass":
          "sha256:6bfe7b0617ea29eeaaaa383444248f6d92f32fe9200ba22f1a643c00e6dbbf47",
      },
    };
    const shared = new Map<string, string>();
    for (const [dir, pinned] of Object.entries(onMain)) {
      const config = resolveSessionCatalog(
        await readCatalogConfig(join(DEFAULT_CONFIG_DIR, dir)),
        () => "placeholder-credential-value",
      );
      for (const [id, digest] of Object.entries(pinned)) {
        const profile = config.profiles[id];
        expect(profile && profileFingerprint(profile)).toBe(digest);
      }
      for (const [id, profile] of Object.entries(config.profiles)) {
        const digest = profileFingerprint(profile);
        expect(shared.get(id) ?? digest).toBe(digest);
        shared.set(id, digest);
      }
    }
  });

  test("only the bypass example needs the installation's opt-in", async () => {
    const dir = join(DEFAULT_CONFIG_DIR, "fake-model-unattended");
    const config = await readCatalogConfig(dir);
    expect(unattendedProfiles(config)).toEqual([
      "claude-coding-auto",
      "claude-coding-bypass",
    ]);
    expect(optInProfiles(config)).toEqual(["claude-coding-bypass"]);
    expect(config.repositories["sample-app"]?.profiles).toEqual([
      "claude-coding-local",
      "claude-coding-auto",
      "claude-coding-bypass",
    ]);
    expect(await failure(loadCatalogConfig({ dir, env: {} }))).toContain(
      `${ALLOW_UNATTENDED_SETTING}=true`,
    );
    const allowed = await loadCatalogConfig({
      dir,
      env: { [ALLOW_UNATTENDED_SETTING]: "true" },
    });
    expect(allowed.profiles["claude-coding-bypass"]?.permission_mode).toBe(
      "bypassPermissions",
    );
  });

  test("a profile of a kind the image does not ship parses, then stops the load", async () => {
    const dir = await dirWith({
      [PROFILES_FILE]: PROFILES.replace(
        "from-secrets:\n    runtime_kind: claude_agent_sdk",
        "from-secrets:\n    runtime_kind: codex_app_server",
      ),
    });
    expect((await readCatalogConfig(dir)).profiles["from-secrets"]).toEqual(
      expect.objectContaining({ runtime_kind: "codex_app_server" }),
    );
    expect(
      await failure(
        loadSessionCatalog({
          dir,
          env: { PROVIDER_KEY: ENV_VALUE },
          readSecret: secrets,
        }),
      ),
    ).toBe(
      "Catalog profile(s) refused: from-secrets: Runtime codex_app_server is not installed (installed: claude_agent_sdk)",
    );
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

  test("the shipped profiles keep the fingerprints main computed before `repository` existed", async () => {
    // Captured on main 015a1634; a profile they no longer name fails every
    // session pinned to it with CATALOG_MISMATCH.
    const before = {
      ".": {
        "claude-coding-real":
          "sha256:9aa74e1f9a8acefabe103d06d97a92ee00fc98eed014d634356caa66472f735c",
      },
      "fake-model": {
        "claude-coding-local":
          "sha256:a4c77446d640fa3aebb3c5ccc66f2b3d2a1ab475a431435b320f50852c16ac57",
      },
    };
    for (const [dir, expected] of Object.entries(before)) {
      const catalog = resolveSessionCatalog(
        await readCatalogConfig(join(DEFAULT_CONFIG_DIR, dir)),
        () => "placeholder-credential-value",
      );
      const pinned = Object.keys(expected).map((id) => {
        const profile = catalog.profiles[id];
        if (profile === undefined) throw new Error(`${dir}: no profile ${id}`);
        return [id, profile] as const;
      });
      for (const [id, profile] of pinned) {
        expect(
          profilePinned(profile, expected[id as keyof typeof expected]),
        ).toBe(true);
      }
      for (const [, profile] of pinned) {
        expect(repositoryModeOf(profile)).toBe("required");
      }
    }
  });

  test("the fake-model catalog offers a profile that runs without a repository", async () => {
    const catalog = resolveSessionCatalog(
      await readCatalogConfig(join(DEFAULT_CONFIG_DIR, "fake-model")),
      () => "placeholder-credential-value",
    );
    const general = catalog.profiles.general;
    const coding = catalog.profiles["claude-coding-local"];
    if (general === undefined || coding === undefined) {
      throw new Error("fake-model catalog lacks a profile");
    }
    expect(repositoryModeOf(general)).toBe("none");
    expect(general.tools).not.toContain("Bash");
    expect(general.provider).toEqual(coding.provider);
  });
});
