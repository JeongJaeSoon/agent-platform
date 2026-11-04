import { describe, expect, test } from "bun:test";
import type { InstallationSettings } from "../ports/installation-settings-store.ts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  type CredentialRef,
  catalogProfileConfigSchema,
  environmentCredentials,
  mcpBinding,
  profileFingerprint,
  repositoryBinding,
  resolveSessionCatalog,
  type SessionCatalogConfig,
} from "./catalog.ts";
import {
  settingsSnapshot,
  withStoredValues,
} from "./installation-settings.ts";
import {
  catalogRows,
  createProfileRegistry,
  installationProfileSnapshot,
  profileCatalog,
  type SnapshotSources,
} from "./profile-registry.ts";

const ENV = {
  ANTHROPIC_KEY: "sk-ant-file-key-0001",
  TOOL_TOKEN: "ghp-tool-token-0001",
  MCP_TOKEN: "mcp-bearer-token-0001",
};

const CONNECTIONS: Record<string, CatalogProfileConfig["provider"]> = {
  anthropic: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value_env: "ANTHROPIC_KEY" },
  },
};

// repositories.yaml and mcp-servers.yaml as the files hold them.
const FILES: SessionCatalogConfig = {
  profiles: {
    coding: catalogProfileConfigSchema.parse({
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default",
      provider: CONNECTIONS.anthropic,
    }),
  },
  repositories: {
    tool: {
      url: "https://git.example.com/acme/tool.git",
      branch: "main",
      profiles: ["coding"],
      auth: { kind: "basic", username: "x-access-token", value_env: "TOOL_TOKEN" },
    },
    docs: { url: "https://git.example.com/acme/docs.git", branch: "main" },
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      profiles: ["coding"],
      auth: { kind: "github_app" },
    },
  },
  mcp_servers: {
    tracker: {
      url: "https://mcp.example.com/sse",
      credential_ref: "tracker",
      auth: { kind: "bearer", value_env: "MCP_TOKEN" },
      workspaces: ["acme"],
    },
  },
};

// What the settings store reads back for the same entries.
function databaseRead(
  overrides: Partial<InstallationSettings> = {},
): InstallationSettings {
  return {
    generation: 3,
    connections: Object.entries(CONNECTIONS).map(([id, provider]) => ({
      id,
      provider,
    })),
    repositories: Object.entries(FILES.repositories).map(([id, repository]) => ({
      id,
      repository,
    })),
    mcpServers: Object.entries(FILES.mcp_servers ?? {}).map(([id, server]) => ({
      id,
      server,
    })),
    stored: new Map(),
    invalid: [],
    ...overrides,
  };
}

const fileLookup = environmentCredentials(ENV);

function materializeWith(
  fallback: (ref: CredentialRef) => string | undefined,
): SnapshotSources<CatalogProfile>["materialize"] {
  return (id, definition, lookup = fallback) => {
    const profile = resolveSessionCatalog(
      { profiles: { [id]: definition }, repositories: {} },
      lookup,
    ).profiles[id];
    if (!profile) throw new Error(`profile ${id} did not resolve`);
    return profile;
  };
}

describe("installation settings read from the database", () => {
  const file = resolveSessionCatalog(FILES, fileLookup);
  const read = databaseRead();
  const db = settingsSnapshot(read, withStoredValues(read, fileLookup));

  test("repositories bind exactly as their file entries did", () => {
    expect(Object.keys(db.repositories).sort()).toEqual(["app", "docs", "tool"]);
    for (const [id, repository] of Object.entries(file.repositories)) {
      const fromDb = db.repositories[id];
      if (!fromDb) throw new Error(`${id} missing`);
      expect(fromDb).toEqual(repository);
      expect(repositoryBinding(id, fromDb)).toBe(
        repositoryBinding(id, repository),
      );
    }
  });

  test("an MCP server binds and routes as its file entry did", () => {
    const fromFile = file.mcp_servers?.tracker;
    const fromDb = db.mcp_servers.tracker;
    if (!fromFile || !fromDb) throw new Error("tracker missing");
    expect(fromDb).toEqual(fromFile);
    expect(mcpBinding("rel_1", "tracker", fromDb)).toBe(
      mcpBinding("rel_1", "tracker", fromFile),
    );
  });

  test("a ceiling on a connection runs the same profile, so its fingerprint and release inputs hold", () => {
    const sources: SnapshotSources<CatalogProfile> = {
      connections: CONNECTIONS,
      repositoryIdsOf: () => ["app", "tool"],
      allowUnattended: false,
      runtimeSupported: () => true,
      materialize: materializeWith(fileLookup),
    };
    const rows = catalogRows(FILES.profiles, FILES.repositories);
    const fromFile = installationProfileSnapshot(sources, rows).profiles.coding;
    const fromDb = installationProfileSnapshot(
      {
        ...sources,
        connections: db.connections,
        materialize: (id, definition) =>
          sources.materialize(id, definition, db.lookup),
      },
      rows,
    ).profiles.coding;
    if (!fromFile || !fromDb) throw new Error("coding missing");
    expect(fromDb).toEqual(fromFile);
    expect(profileFingerprint(fromDb)).toBe(profileFingerprint(fromFile));
  });

  test("a stored value resolves; rotating it changes the value and no fingerprint or binding", () => {
    const stored: InstallationSettings = databaseRead({
      connections: [
        {
          id: "console",
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.com",
            auth: { kind: "api_key", stored: "connection:console" },
          },
        },
      ],
      repositories: [
        {
          id: "pat",
          repository: {
            url: "https://git.example.com/acme/pat.git",
            branch: "main",
            auth: { kind: "bearer", stored: "repository:pat" },
          },
        },
      ],
      mcpServers: [],
      stored: new Map([
        ["connection:console", "sk-ant-stored-v1-0001"],
        ["repository:pat", "pat-stored-v1-00001"],
      ]),
    });
    const rotated: InstallationSettings = {
      ...stored,
      stored: new Map([
        ["connection:console", "sk-ant-stored-v2-0002"],
        ["repository:pat", "pat-stored-v2-00002"],
      ]),
    };
    const before = settingsSnapshot(stored, withStoredValues(stored, fileLookup));
    const after = settingsSnapshot(rotated, withStoredValues(rotated, fileLookup));
    const definition = {
      ...(FILES.profiles.coding as CatalogProfileConfig),
      provider: stored.connections[0]?.provider as CatalogProfileConfig["provider"],
    };
    const materialize = materializeWith(fileLookup);
    const v1 = materialize("coding", definition, before.lookup);
    const v2 = materialize("coding", definition, after.lookup);
    expect(v1.provider.auth.value).toBe("sk-ant-stored-v1-0001");
    expect(v2.provider.auth.value).toBe("sk-ant-stored-v2-0002");
    expect(profileFingerprint(v2)).toBe(profileFingerprint(v1));
    const [pat1, pat2] = [before.repositories.pat, after.repositories.pat];
    if (!pat1 || !pat2) throw new Error("pat missing");
    expect(pat2.auth).toMatchObject({ value: "pat-stored-v2-00002" });
    expect(repositoryBinding("pat", pat2)).toBe(repositoryBinding("pat", pat1));
  });

  test("a row whose credential does not resolve is left out alone, never with its value", () => {
    const read = databaseRead({
      invalid: ["mcp:broken"],
    });
    const snapshot = settingsSnapshot(
      read,
      withStoredValues(read, environmentCredentials({ ...ENV, TOOL_TOKEN: "" })),
    );
    expect(Object.keys(snapshot.repositories).sort()).toEqual(["app", "docs"]);
    expect(Object.keys(snapshot.connections)).toEqual(["anthropic"]);
    expect(snapshot.left_out.map(({ entry }) => entry).sort()).toEqual([
      "mcp:broken",
      "repository:tool",
    ]);
    expect(JSON.stringify(snapshot.left_out)).not.toContain(ENV.TOOL_TOKEN);
  });
});

describe("the registry's catalog over the settings", () => {
  const SOURCES: SnapshotSources<CatalogProfile> = {
    connections: {},
    repositoryIdsOf: () => [],
    allowUnattended: false,
    runtimeSupported: () => true,
    materialize: materializeWith(fileLookup),
  };

  test("follows the reads, keeps its repositories object while they are equal, and carries the generation", async () => {
    let read = databaseRead();
    const registry = createProfileRegistry({
      workspaces: { listAll: async () => [] },
      installations: { listAll: async () => [] },
      settings: {
        read: async () =>
          settingsSnapshot(read, withStoredValues(read, fileLookup)),
      },
      sources: SOURCES,
    });
    const base = { repositories: {} };
    const catalog = profileCatalog(base, registry);
    // Before the first read: what the process started with.
    expect(catalog.repositories).toBe(base.repositories);
    expect(catalog.settings_generation).toBeUndefined();

    await registry.refresh();
    const first = catalog.repositories;
    expect(Object.keys(first).sort()).toEqual(["app", "docs", "tool"]);
    expect(Object.keys(catalog.mcp_servers ?? {})).toEqual(["tracker"]);
    expect(catalog.settings_generation).toBe(3);
    // The gateway's claim cache keys on this object.
    await registry.refresh();
    expect(catalog.repositories).toBe(first);

    read = databaseRead({
      generation: 4,
      repositories: [
        {
          id: "docs",
          repository: {
            url: "https://git.example.com/acme/docs.git",
            branch: "develop",
          },
        },
      ],
    });
    await registry.refresh();
    expect(catalog.repositories).not.toBe(first);
    expect(Object.keys(catalog.repositories)).toEqual(["docs"]);
    expect(catalog.repositories.docs?.branch).toBe("develop");
    expect(catalog.settings_generation).toBe(4);
  });

  test("a ceiling runs on the settings' connections, not the ones the process started with", async () => {
    const registry = createProfileRegistry({
      workspaces: { listAll: async () => [] },
      installations: {
        listAll: async () => catalogRows(FILES.profiles, FILES.repositories),
      },
      settings: {
        read: async () => {
          const read = databaseRead();
          return settingsSnapshot(read, withStoredValues(read, fileLookup));
        },
      },
      sources: SOURCES,
    });
    await registry.refresh();
    expect(Object.keys(registry.profiles)).toEqual(["coding"]);
    expect(registry.installation.get("coding")?.connection_id).toBe(
      "anthropic",
    );
  });
});
