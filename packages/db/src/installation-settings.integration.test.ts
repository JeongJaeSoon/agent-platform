import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  type CatalogProfile,
  catalogRevision,
  createProfileRegistry,
  profileCatalog,
  resolveSessionCatalog,
  SecretKey,
  type SecretOwner,
  settingsSnapshot,
  withStoredValues,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresInstallationSettingsStore } from "./installation-settings.ts";
import * as schema from "./schema.ts";
import {
  catalogRepositories,
  mcpServers,
  providerConnections,
  secretValues,
  workspaces,
} from "./schema.ts";
import { createPostgresSecretStore } from "./secret-values.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// Made per run: a fixed token-shaped string has no place in a file.
const fakeValue = () => randomBytes(18).toString("hex");

integration("installation settings on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "installation_settings_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme" });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const store = () => createPostgresInstallationSettingsStore(db, key);

  const IMPORT = {
    connections: {
      anthropic: {
        kind: "anthropic" as const,
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key" as const, value_env: "ANTHROPIC_KEY" },
      },
    },
    repositories: {
      tool: {
        url: "https://git.example.com/acme/tool.git",
        branch: "main",
        profiles: ["coding"],
        auth: {
          kind: "basic" as const,
          username: "x-access-token",
          value_env: "TOOL_TOKEN",
        },
      },
      docs: { url: "https://git.example.com/acme/docs.git", branch: "main" },
    },
    mcpServers: {
      tracker: {
        url: "https://mcp.example.com/sse",
        credential_ref: "tracker",
        auth: { kind: "bearer" as const, value_env: "MCP_TOKEN" },
        workspaces: ["acme"],
      },
    },
  };

  test("the import writes each id once, reads back as the files said, and names what the files now say differently", async () => {
    const settings = store();
    const before = await settings.generation();
    expect(await settings.importSettings(IMPORT)).toEqual({
      inserted: [
        "connection:anthropic",
        "repository:tool",
        "repository:docs",
        "mcp:tracker",
      ],
      conflicts: [],
    });
    const afterImport = await settings.generation();
    expect(afterImport).toBeGreaterThan(before);

    const read = await settings.read();
    expect(read.generation).toBe(afterImport);
    expect(read.invalid).toEqual([]);
    expect(read.connections).toEqual([
      { id: "anthropic", provider: IMPORT.connections.anthropic },
    ]);
    expect(read.repositories).toEqual([
      { id: "docs", repository: IMPORT.repositories.docs },
      { id: "tool", repository: IMPORT.repositories.tool },
    ]);
    expect(read.mcpServers).toEqual([
      { id: "tracker", server: IMPORT.mcpServers.tracker },
    ]);

    // The next start imports the same files: nothing written, nothing moved.
    expect(await settings.importSettings(IMPORT)).toEqual({
      inserted: [],
      conflicts: [],
    });
    expect(await settings.generation()).toBe(afterImport);

    const changed = {
      ...IMPORT,
      repositories: {
        ...IMPORT.repositories,
        docs: { ...IMPORT.repositories.docs, branch: "develop" },
      },
    };
    expect(await settings.importSettings(changed)).toEqual({
      inserted: [],
      conflicts: ["repository:docs"],
    });
    const [docs] = await db
      .select({ branch: catalogRepositories.branch })
      .from(catalogRepositories)
      .where(eq(catalogRepositories.id, "docs"));
    expect(docs?.branch).toBe("main");
  });

  test("every settings table moves the generation; a row it cannot parse is named, not dropped silently", async () => {
    const settings = store();
    let last = await settings.generation();
    const moved = async () => {
      const now = await settings.generation();
      expect(now).toBeGreaterThan(last);
      last = now;
    };
    await db
      .update(providerConnections)
      .set({ disabledAt: new Date() })
      .where(eq(providerConnections.id, "anthropic"));
    await moved();
    await db
      .update(providerConnections)
      .set({ disabledAt: null })
      .where(eq(providerConnections.id, "anthropic"));
    await moved();
    await db.execute(
      sql`UPDATE mcp_servers SET auth = '{"kind":"nonsense"}'::jsonb WHERE id = 'tracker'`,
    );
    await moved();
    await db.execute(
      sql`UPDATE catalog_repositories SET branch = branch WHERE id = 'docs'`,
    );
    await moved();
    await db.execute(
      sql`UPDATE installation_profiles SET version = version WHERE false`,
    );
    expect(await settings.generation()).toBe(last);

    const read = await settings.read();
    expect(read.invalid).toEqual(["mcp:tracker"]);
    expect(read.mcpServers).toEqual([]);
    await db
      .update(mcpServers)
      .set({ auth: IMPORT.mcpServers.tracker.auth })
      .where(eq(mcpServers.id, "tracker"));
  });

  test("a stored value is read with the settings; rotating it changes the value only, so the catalog revision and the generation hold", async () => {
    const settings = store();
    await db.insert(catalogRepositories).values({
      id: "pat",
      owner: "acme",
      name: "pat",
      url: "https://git.example.com/acme/pat.git",
      branch: "main",
      authKind: "bearer",
      auth: { kind: "bearer", stored: "repository:pat" },
      credentialSource: "stored",
      source: "import",
    });
    const first = fakeValue();
    await settings.putStoredValue({ kind: "repository", id: "pat" }, first, null);
    const generation = await settings.generation();

    const registry = createProfileRegistry<CatalogProfile>({
      workspaces: { listAll: async () => [] },
      installations: { listAll: async () => [] },
      settings: {
        read: async () => {
          const read = await settings.read();
          return settingsSnapshot(
            read,
            withStoredValues(read, (ref) =>
              "value_env" in ref ? `env-${ref.value_env}` : undefined,
            ),
          );
        },
      },
      sources: {
        connections: {},
        repositoryIdsOf: () => [],
        allowUnattended: false,
        runtimeSupported: () => true,
        materialize: () => {
          throw new Error("no ceilings in this test");
        },
      },
    });
    const catalog = profileCatalog(
      resolveSessionCatalog({ profiles: {}, repositories: {} }, () => "x"),
      registry,
    );
    await registry.refresh();
    expect(catalog.repositories.pat?.auth).toMatchObject({ value: first });
    const revision = catalogRevision(catalog);

    const second = fakeValue();
    await settings.putStoredValue(
      { kind: "repository", id: "pat" },
      second,
      null,
    );
    expect(await settings.generation()).toBe(generation);
    await registry.refresh();
    expect(catalog.repositories.pat?.auth).toMatchObject({ value: second });
    expect(catalogRevision(catalog)).toBe(revision);
    expect(catalog.settings_generation).toBe(generation);

    // Sealed at rest, like every other secret value.
    const rows = await db
      .select({ ownerRef: secretValues.ownerRef, purpose: secretValues.purpose })
      .from(secretValues)
      .where(eq(secretValues.purpose, "settings_credential"));
    expect(rows).toEqual([
      { ownerRef: "repository:pat", purpose: "settings_credential" },
    ]);
    const raw = JSON.stringify(
      (await db.execute(sql`SELECT * FROM secret_values`)).rows,
    );
    expect(raw).not.toContain(second);
  });

  test("a store with the secret store off reads the rows and no value, and refuses to keep one", async () => {
    const off = createPostgresInstallationSettingsStore(db, null);
    const read = await off.read();
    expect(read.stored.size).toBe(0);
    expect(read.repositories.map(({ id }) => id)).toContain("pat");
    await expect(
      off.putStoredValue({ kind: "repository", id: "pat" }, fakeValue(), null),
    ).rejects.toThrow("secret store is off");
  });

  test("the workspace secret store neither reads, describes, writes nor deletes an installation setting's value", async () => {
    const [workspace] = await db.select({ id: workspaces.id }).from(workspaces);
    if (!workspace) throw new Error("no workspace");
    const secrets = createPostgresSecretStore(db, key);
    for (const kind of ["connection", "repository", "mcp"] as const) {
      const slot = {
        workspaceId: workspace.id,
        owner: { kind, id: "pat" } as SecretOwner,
        purpose: "settings_credential" as const,
      };
      // Thrown or rejected, whichever the method does: never answered.
      const refusal = async (call: () => unknown) => {
        try {
          await call();
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "answered";
      };
      for (const call of [
        () => secrets.get(slot),
        () => secrets.describe(slot),
        () => secrets.put(slot, fakeValue()),
        () => secrets.delete(slot),
      ]) {
        expect(await refusal(call)).toContain("installation's settings");
      }
    }
    const [row] = await db
      .select({ ownerRef: secretValues.ownerRef })
      .from(secretValues)
      .where(eq(secretValues.ownerRef, "repository:pat"));
    expect(row?.ownerRef).toBe("repository:pat");
  });
});
