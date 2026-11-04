import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import * as schema from "@werft-ai/db";
import {
  createPostgresCatalogRepositoryStore,
  createPostgresInstallationSettingsStore,
  createPostgresSettingsDocumentStore,
} from "@werft-ai/db";
import {
  type CatalogProfile,
  type Connections,
  type CredentialRef,
  catalogRows,
  createProfileRegistry,
  parseSettingsDocument,
  profileFingerprint,
  resolveSessionCatalog,
  settingsSnapshot,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  readCatalogConfig,
  readConnections,
  readSeedProfiles,
} from "./catalog-config.ts";
import { documentFromDir } from "./settings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const FAKE_MODEL_DIR = resolve(
  import.meta.dir,
  "../../../../config/fake-model",
);
// Any reference resolves: what matters is which connection a ceiling finds.
const lookup = (_ref: CredentialRef) => "a-fake-provider-key";

integration("the fake-model stack's settings through a document", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_cli_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function ceilings(connections: Connections) {
    const config = await readCatalogConfig(FAKE_MODEL_DIR);
    const seed = await readSeedProfiles(FAKE_MODEL_DIR, config);
    const settings = createPostgresInstallationSettingsStore(db, null);
    const registry = createProfileRegistry<CatalogProfile>({
      workspaces: { listAll: async () => [] },
      installations: {
        listAll: async () => catalogRows(seed, config.repositories),
      },
      repositories: createPostgresCatalogRepositoryStore(db),
      settings: {
        read: async () => settingsSnapshot(await settings.read(), lookup),
      },
      sources: {
        connections,
        repositoryIdsOf: () => [],
        allowUnattended: false,
        runtimeSupported: () => true,
        materialize: (id, definition, settingsLookup) => {
          const profile = resolveSessionCatalog(
            { profiles: { [id]: definition }, repositories: {} },
            (ref) => settingsLookup?.(ref) ?? lookup(ref),
          ).profiles[id];
          if (!profile) throw new Error(`no ${id}`);
          return profile;
        },
      },
    });
    await registry.refresh();
    const entry = registry.installation.get("claude-coding-local");
    const profile = registry.profiles["claude-coding-local"];
    return {
      state: entry?.state,
      fingerprint: profile ? profileFingerprint(profile) : null,
    };
  }

  test("with connections.yaml emptied, the imported fake-messages connection runs the fake ceiling as the file did", async () => {
    const fromFile = await ceilings(await readConnections(FAKE_MODEL_DIR));
    expect(fromFile.state).toBe("usable");
    expect(await ceilings({})).toMatchObject({ state: "connection_missing" });

    const { document } = await documentFromDir(FAKE_MODEL_DIR);
    const result = await createPostgresSettingsDocumentStore(db).importEntries(
      parseSettingsDocument(document),
      {
        dryRun: false,
        allowExternal: true,
        actor: null,
      },
    );
    expect(result.outcome).toBe("applied");

    expect(await ceilings({})).toEqual(fromFile);
  }, 30_000);
});
