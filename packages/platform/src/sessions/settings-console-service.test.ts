import { describe, expect, test } from "bun:test";
import {
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type {
  SettingsConsoleResult,
  SettingsDocumentStore,
  SettingsRow,
} from "../ports/settings-document-store.ts";
import { SessionServiceError } from "./session-service.ts";
import {
  createSettingsConsoleService,
  type SettingsFileEntries,
} from "./settings-console-service.ts";
import type { SettingsKind } from "./settings-document.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

function caller(who: keyof typeof USERS): Caller {
  const role: WorkspaceRole = who;
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
}

const apiKey = callerFor(
  {
    kind: "api_key",
    id: "key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  } as Principal,
  { kind: "api" },
  crypto.randomUUID(),
);

const FILES: SettingsFileEntries = {
  connections: {
    fake: {
      kind: "anthropic",
      endpoint: "http://fake-model:8080",
      billing: "none",
      auth: { kind: "api_key", value_env: "FAKE_MODEL_KEY" },
    },
  },
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app" },
    },
    public: {
      url: "https://git.example.invalid/acme/public.git",
      branch: "main",
    },
  },
  mcp_servers: {},
};

const AT = new Date("2026-11-04T03:00:00.000Z");
const connectionRow = (
  id: string,
  over: Partial<SettingsRow> = {},
): SettingsRow => ({
  id,
  entry: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", stored: `connection:${id}` },
  },
  origin: "console",
  last4: "wxyz",
  createdAt: AT,
  disabledAt: null,
  ...over,
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

function service(
  options: {
    rows?: Partial<Record<SettingsKind, SettingsRow[]>>;
    result?: SettingsConsoleResult;
    secretStoreOn?: boolean;
    leftOut?: string[];
  } = {},
) {
  const writes: unknown[][] = [];
  let rereads = 0;
  const result = options.result ?? { outcome: "done", receiptId: RECEIPT };
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      writes.push([name, ...args.slice(0, -1)]);
      return result;
    };
  const store: SettingsDocumentStore = {
    exportEntries: async () => {
      throw new Error("not used");
    },
    importEntries: async () => {
      throw new Error("not used");
    },
    listRows: async (kind) => options.rows?.[kind] ?? [],
    create: record("create"),
    setValue: record("setValue"),
    disable: record("disable"),
    setMcpWorkspaces: record("setMcpWorkspaces"),
    setRepositoryBranch: record("setRepositoryBranch"),
  };
  const settings = createSettingsConsoleService({
    authorization: createAuthorizationPolicy({
      agents: { agentOf: async () => null, isAdmin: async () => false },
      decisions: { record: async () => {} },
    }),
    store,
    files: () => FILES,
    leftOut: () => (options.leftOut ?? []).map((entry) => ({ entry })),
    secretStoreOn: options.secretStoreOn ?? true,
    credentialHosts: ["api.anthropic.com:443"],
    reread: async () => {
      rereads += 1;
    },
  });
  return { settings, writes, rereads: () => rereads };
}

const NEW_CONNECTION = {
  id: "console",
  kind: "anthropic" as const,
  endpoint: "https://api.anthropic.invalid",
  auth_kind: "api_key" as const,
  value: "example-key-1234",
};

describe("settings console service", () => {
  test("connections and MCP servers are the signed-in owner's; repositories owners' and admins'", async () => {
    const { settings, writes } = service();
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect((await refusal(settings.listConnections(who))).code).toBe(
        "FORBIDDEN",
      );
      expect((await refusal(settings.listMcpServers(who))).code).toBe(
        "FORBIDDEN",
      );
      expect(
        (await refusal(settings.createConnection(who, NEW_CONNECTION))).code,
      ).toBe("FORBIDDEN");
      expect((await refusal(settings.disable(who, "mcp", "docs"))).code).toBe(
        "FORBIDDEN",
      );
      expect(
        (await refusal(settings.setCredential(who, "connection", "c", "v")))
          .code,
      ).toBe("FORBIDDEN");
    }
    for (const who of [caller("member"), apiKey]) {
      expect((await refusal(settings.listRepositories(who))).code).toBe(
        "FORBIDDEN",
      );
      expect(
        (await refusal(settings.disable(who, "repository", "public"))).code,
      ).toBe("FORBIDDEN");
    }
    expect(writes).toEqual([]);
    await settings.listRepositories(caller("admin"));
    await settings.disable(caller("admin"), "repository", "docs-site");
    expect(writes).toEqual([
      ["disable", { kind: "repository", id: "docs-site" }],
    ]);
  });

  test("a connection is made stored under its own id, with the typed value, then the settings are read again", async () => {
    const { settings, writes, rereads } = service();
    const made = await settings.createConnection(caller("owner"), {
      ...NEW_CONNECTION,
      billing: "none",
    });
    expect(made).toEqual({ id: "console", receipt_id: RECEIPT });
    expect(writes).toEqual([
      [
        "create",
        {
          kind: "connection",
          id: "console",
          entry: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            billing: "none",
            auth: { kind: "api_key", stored: "connection:console" },
          },
        },
        "example-key-1234",
      ],
    ]);
    expect(rereads()).toBe(1);
  });

  test("an id the operator's file holds, an entry the catalog refuses and a closed secret store are refused before the store", async () => {
    const { settings, writes } = service();
    expect(
      (
        await refusal(
          settings.createConnection(caller("owner"), {
            ...NEW_CONNECTION,
            id: "fake",
          }),
        )
      ).details,
    ).toMatchObject({ reason_code: "file_entry" });
    const bad = await refusal(
      settings.createConnection(caller("owner"), {
        ...NEW_CONNECTION,
        endpoint: "ftp://models.invalid",
      }),
    );
    expect(bad.code).toBe("BAD_REQUEST");
    expect(bad.details).toMatchObject({ reason_code: "invalid_entry" });
    // Anthropic takes only an api_key.
    expect(
      (
        await refusal(
          settings.createConnection(caller("owner"), {
            ...NEW_CONNECTION,
            auth_kind: "bearer",
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(
      (
        await refusal(
          settings.createMcpServer(caller("owner"), {
            id: "github",
            url: "https://mcp.example.invalid/mcp",
            credential_ref: "docs_mcp",
            workspaces: ["acme"],
            value: "v",
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(
      (
        await refusal(
          settings.setMcpWorkspaces(caller("owner"), "docs", ["a", "a"]),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(writes).toEqual([]);

    const closed = service({ secretStoreOn: false });
    expect(
      (
        await refusal(
          closed.settings.createConnection(caller("owner"), NEW_CONNECTION),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(
      (
        await refusal(
          closed.settings.setCredential(caller("owner"), "mcp", "docs", "v"),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    // A public repository holds no value, so it needs no secret store.
    await closed.settings.createRepository(caller("owner"), {
      id: "docs-site",
      url: "https://git.example.invalid/acme/docs-site.git",
      branch: "main",
      auth: { kind: "none" },
    });
    expect(closed.writes).toHaveLength(1);
  });

  test("a PAT repository is stored with its username; the URL and branch go as typed", async () => {
    const { settings, writes } = service();
    await settings.createRepository(caller("admin"), {
      id: "docs-site",
      url: "https://git.example.invalid/acme/docs-site.git",
      branch: "main",
      auth: { kind: "basic", username: "bot", value: "example-token" },
    });
    expect(writes).toEqual([
      [
        "create",
        {
          kind: "repository",
          id: "docs-site",
          entry: {
            url: "https://git.example.invalid/acme/docs-site.git",
            branch: "main",
            auth: {
              kind: "basic",
              username: "bot",
              stored: "repository:docs-site",
            },
          },
        },
        "example-token",
      ],
    ]);
  });

  test("the store's refusals map to their codes and reason", async () => {
    for (const [result, code, reason] of [
      [{ outcome: "actor_inactive" }, "FORBIDDEN", "role"],
      [{ outcome: "not_found" }, "NOT_FOUND", undefined],
      [
        { outcome: "conflict", reason: "already_exists" },
        "REVISION_CONFLICT",
        "already_exists",
      ],
      [
        { outcome: "conflict", reason: "not_stored" },
        "REVISION_CONFLICT",
        "not_stored",
      ],
      [
        { outcome: "conflict", reason: "disabled" },
        "REVISION_CONFLICT",
        "disabled",
      ],
    ] as const) {
      const { settings, rereads } = service({ result });
      const refused = await refusal(
        settings.disable(caller("owner"), "connection", "console"),
      );
      expect(refused.code).toBe(code);
      if (reason !== undefined) {
        expect(refused.details).toMatchObject({ reason_code: reason });
      }
      expect(rereads()).toBe(0);
    }
  });

  test("the list joins the file's entries and the rows, and tells each row's state; never a value", async () => {
    const { settings } = service({
      rows: {
        connection: [
          connectionRow("console"),
          connectionRow("empty", { last4: null }),
          connectionRow("off", { disabledAt: AT }),
          connectionRow("fake", { origin: "import" }),
          connectionRow("broken"),
        ],
      },
      leftOut: ["connection:broken"],
    });
    const listed = await settings.listConnections(caller("owner"));
    expect(listed.credential_hosts).toEqual(["api.anthropic.com:443"]);
    expect(
      listed.items.map((item) => [item.id, item.origin, item.state]),
    ).toEqual([
      ["broken", "console", "unresolved"],
      ["console", "console", "active"],
      ["empty", "console", "needs_value"],
      ["fake", "file", "active"],
      ["fake", "import", "shadowed"],
      ["off", "console", "disabled"],
    ]);
    expect(listed.items.find((item) => item.origin === "file")).toMatchObject({
      billing: "none",
      credential: { source: "external", value_env: "FAKE_MODEL_KEY" },
      created_at: null,
    });
    expect(listed.items.find((item) => item.id === "console")).toMatchObject({
      credential: { source: "stored", last4: "wxyz" },
      created_at: AT.toISOString(),
    });
    expect(JSON.stringify(listed)).not.toContain("connection:console");

    // The console App's repositories are the GitHub screen's.
    const repositories = await settings.listRepositories(caller("owner"));
    expect(repositories.items.map((item) => [item.id, item.auth_kind])).toEqual(
      [["public", "none"]],
    );
  });
});
