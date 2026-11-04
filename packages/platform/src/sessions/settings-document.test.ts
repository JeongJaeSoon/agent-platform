import { describe, expect, test } from "bun:test";
import {
  type ExistingSettings,
  parseSeedDocument,
  parseSettingsDocument,
  planSettingsImport,
  repositoryNameOf,
  SettingsDocumentError,
  settingsDocumentDigest,
  settingsDocumentOf,
} from "./settings-document.ts";

const DOCUMENT = {
  version: 1,
  connections: {
    main: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", value_env: "ANTHROPIC_API_KEY" },
    },
    console: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true, last4: "wxyz" },
    },
  },
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app" },
    },
    open: { url: "http://fake-git:3000/agent/sample-app.git", branch: "main" },
  },
  mcp_servers: {
    docs: {
      url: "https://mcp.example.invalid/docs",
      credential_ref: "docs_token",
      auth: { kind: "bearer", value_env: "MCP_TOKEN" },
      workspaces: ["acme"],
    },
  },
};

const NONE: ExistingSettings = {
  connections: new Map(),
  repositories: new Map(),
  mcp_servers: new Map(),
  stored_values: new Set(),
};

describe("parseSettingsDocument", () => {
  test("binds a stored entry to its own row and drops last4", () => {
    const entries = parseSettingsDocument(DOCUMENT);
    expect(entries.connections.console?.auth).toEqual({
      kind: "api_key",
      stored: "connection:console",
    });
    expect(entries.connections.main?.auth).toEqual({
      kind: "api_key",
      value_env: "ANTHROPIC_API_KEY",
    });
  });

  test("refuses a stored reference naming any row, its own included", () => {
    for (const stored of ["connection:main", "connection:console", "yes"]) {
      expect(() =>
        parseSettingsDocument({
          ...DOCUMENT,
          connections: {
            console: {
              kind: "anthropic",
              endpoint: "https://api.anthropic.invalid",
              auth: { kind: "api_key", stored },
            },
          },
        }),
      ).toThrow(SettingsDocumentError);
    }
  });

  test("holds the file catalog's rules", () => {
    for (const bad of [
      { ...DOCUMENT, version: 2 },
      { ...DOCUMENT, profiles: {} },
      {
        ...DOCUMENT,
        mcp_servers: { github: DOCUMENT.mcp_servers.docs },
      },
      {
        ...DOCUMENT,
        repositories: {
          leaky: {
            url: "https://u:p@git.example.invalid/a/b.git",
            branch: "main",
          },
        },
      },
      {
        ...DOCUMENT,
        connections: {
          both: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: { kind: "api_key", value_env: "A", stored: true },
          },
        },
      },
    ]) {
      expect(() => parseSettingsDocument(bad)).toThrow(SettingsDocumentError);
    }
  });

  test("exports back to the document it read, digest and all", () => {
    const entries = parseSettingsDocument(DOCUMENT);
    const exported = settingsDocumentOf(
      entries,
      new Map([["connection:console", "wxyz"]]),
    );
    expect(exported).toEqual(DOCUMENT as typeof exported);
    expect(parseSettingsDocument(exported)).toEqual(entries);
    expect(settingsDocumentDigest(exported)).toBe(
      settingsDocumentDigest(structuredClone(DOCUMENT) as typeof exported),
    );
    expect(settingsDocumentDigest(exported)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("an export without a stored value's last4 still holds no value", () => {
    const text = JSON.stringify(
      settingsDocumentOf(parseSettingsDocument(DOCUMENT)),
    );
    expect(text).not.toContain("connection:console");
    expect(text).toContain('"stored":true');
  });
});

describe("parseSeedDocument", () => {
  const PROFILE = {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    repository: "none",
    tools: ["Read"],
    permission_mode: "plan",
    provider: DOCUMENT.connections.main,
  };

  test("a document without `profiles` seeds nothing", () => {
    expect(parseSeedDocument(DOCUMENT)).toEqual({
      entries: parseSettingsDocument(DOCUMENT),
      profiles: null,
    });
  });

  test("the operator's `profiles` is the seed, and the API's parser still refuses it", () => {
    const document = { ...DOCUMENT, profiles: { general: PROFILE } };
    const seed = parseSeedDocument(document);
    expect(Object.keys(seed.profiles ?? {})).toEqual(["general"]);
    expect(seed.entries).toEqual(parseSettingsDocument(DOCUMENT));
    expect(() => parseSettingsDocument(document)).toThrow(
      SettingsDocumentError,
    );
  });

  test("a seed that does not parse refuses the document", () => {
    expect(() =>
      parseSeedDocument({
        ...DOCUMENT,
        profiles: { general: { ...PROFILE, permission_mode: "whatever" } },
      }),
    ).toThrow(SettingsDocumentError);
  });
});

describe("planSettingsImport", () => {
  const entries = parseSettingsDocument(DOCUMENT);

  test("a repository's seed `profiles` is no conflict with its row", () => {
    const seeded = parseSettingsDocument({
      ...DOCUMENT,
      repositories: {
        open: { ...DOCUMENT.repositories.open, profiles: ["general"] },
      },
    });
    const plan = planSettingsImport(
      seeded,
      {
        ...NONE,
        repositories: new Map([
          [
            "open",
            {
              entry: entries.repositories.open,
              active: true,
              has_value: false,
            },
          ],
        ]),
      },
      { allowExternal: true },
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.unchanged).toContain("repository:open");
  });

  test("adds every entry over an empty installation", () => {
    const plan = planSettingsImport(entries, NONE, { allowExternal: true });
    expect(plan.add.map((add) => `${add.kind}:${add.id}`)).toEqual([
      "connection:console",
      "connection:main",
      "repository:app",
      "repository:open",
      "mcp:docs",
    ]);
    expect(plan.needs_value).toEqual(["connection:console"]);
    expect(plan.conflicts).toEqual([]);
  });

  test("refuses new external references when the caller may not bring one", () => {
    const plan = planSettingsImport(entries, NONE, { allowExternal: false });
    expect(plan.refused_external).toEqual(["connection:main", "mcp:docs"]);
    expect(plan.add.map((add) => add.id)).toEqual(["console", "app", "open"]);
  });

  test("an id already held: same content unchanged, other content a conflict, an inactive row stays so", () => {
    const existing: ExistingSettings = {
      ...NONE,
      connections: new Map([
        [
          "main",
          { entry: entries.connections.main, active: true, has_value: false },
        ],
        [
          "console",
          { entry: entries.connections.console, active: true, has_value: true },
        ],
      ]),
      repositories: new Map([
        [
          "open",
          {
            entry: { ...entries.repositories.open, branch: "trunk" },
            active: true,
            has_value: false,
          },
        ],
        [
          "app",
          { entry: entries.repositories.app, active: false, has_value: false },
        ],
      ]),
    };
    const plan = planSettingsImport(entries, existing, {
      allowExternal: false,
    });
    expect(plan.unchanged).toEqual(["connection:console", "connection:main"]);
    expect(plan.inactive).toEqual(["repository:app"]);
    expect(plan.conflicts).toEqual(["repository:open"]);
    expect(plan.refused_external).toEqual(["mcp:docs"]);
    expect(plan.needs_value).toEqual([]);
    expect(plan.add).toEqual([]);
  });

  describe("a GitHub App repository the console moved to another branch", () => {
    const app = (branch: string) => ({
      url: "https://github.com/acme/app",
      branch,
      auth: { kind: "github_app" as const },
    });
    const incoming = { connections: {}, mcp_servers: {} };
    const row = (entry: unknown) => ({
      ...NONE,
      repositories: new Map([
        ["app", { entry, active: true, has_value: false }],
      ]),
    });

    test("stays as the database has it when an old directory is imported", () => {
      const plan = planSettingsImport(
        { ...incoming, repositories: { app: app("main") } },
        row(app("develop")),
        { allowExternal: true, databaseOwnsAppRepositories: true },
      );
      expect(plan.conflicts).toEqual([]);
      expect(plan.kept).toEqual(["repository:app"]);
      expect(plan.add).toEqual([]);
    });

    test("is still a conflict from a settings document", () => {
      const plan = planSettingsImport(
        { ...incoming, repositories: { app: app("main") } },
        row(app("develop")),
        { allowExternal: true },
      );
      expect(plan.conflicts).toEqual(["repository:app"]);
      expect(plan.kept).toBeUndefined();
    });

    test("a repository of another auth kind is still a conflict", () => {
      const { auth: _auth, ...bare } = app("main");
      const plan = planSettingsImport(
        { ...incoming, repositories: { app: bare } },
        row(app("develop")),
        { allowExternal: true, databaseOwnsAppRepositories: true },
      );
      expect(plan.conflicts).toEqual(["repository:app"]);
    });
  });

  test("a GitHub repository another id holds, or a value left on a new stored id, is a conflict", () => {
    const existing: ExistingSettings = {
      ...NONE,
      repositories: new Map([
        [
          "acme-app",
          {
            entry: {
              url: "https://github.com/ACME/App",
              branch: "main",
              auth: { kind: "github_app" },
            },
            active: true,
            has_value: false,
          },
        ],
      ]),
      stored_values: new Set(["connection:console"]),
    };
    const plan = planSettingsImport(entries, existing, { allowExternal: true });
    expect(plan.conflicts).toEqual(["connection:console", "repository:app"]);
    const twice = planSettingsImport(
      {
        ...entries,
        repositories: {
          one: {
            url: "https://github.com/acme/app",
            branch: "main",
            auth: { kind: "github_app" },
          },
          two: {
            url: "https://github.com/Acme/App.git",
            branch: "main",
            auth: { kind: "github_app" },
          },
        },
      },
      NONE,
      { allowExternal: true },
    );
    expect(twice.conflicts).toEqual(["repository:two"]);
  });
});

test("repositoryNameOf labels other hosts by the URL's last two segments", () => {
  expect(
    repositoryNameOf({
      url: "https://git.example.invalid/group/sub/repo.git",
      branch: "main",
    }),
  ).toEqual({ owner: "sub", name: "repo" });
  expect(
    repositoryNameOf({
      url: "https://git.example.invalid/repo",
      branch: "main",
    }),
  ).toEqual({ owner: "", name: "" });
  expect(
    repositoryNameOf({
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app" },
    }),
  ).toEqual({ owner: "acme", name: "app" });
});
