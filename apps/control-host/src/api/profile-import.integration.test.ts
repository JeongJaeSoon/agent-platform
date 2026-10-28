import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@werft-ai/db";
import {
  createPostgresInstallationProfileStore,
  installationProfiles,
} from "@werft-ai/db";
import {
  allowedRun,
  type CatalogProfile,
  catalogConnections,
  catalogProfile,
  catalogRevision,
  catalogRows,
  createProfileRegistry,
  installationProfileSnapshot,
  profileCatalog,
  profileFingerprint,
  profileModels,
  profilePinned,
  profilePins,
  resolveSessionCatalog,
  runtimeConfigOf,
  type SessionCatalogConfig,
  type SnapshotSources,
  type WorkspaceProfileRecord,
  workspaceProfileState,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { slackProfileCatalog } from "../slack/main.ts";
import {
  ALLOW_UNATTENDED_SETTING,
  CONNECTIONS_FILE,
  DEFAULT_CONFIG_DIR,
  readCatalogConfig,
  readConnections,
} from "./catalog-config.ts";
import {
  checkCatalogImport,
  connectionsFromProfiles,
  importCatalogProfiles,
  importCheckClean,
} from "./profile-import.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const CATALOGS = [".", "fake-model", "fake-model-unattended", "local-model"];
const PLACEHOLDER = "placeholder-credential-value";
const quiet = { info: () => {}, warn: () => {} };

// Computed on main at 304c2713 (catalog-config.test.ts): sessions and
// releases pin these, so the database path must give the same.
const ON_MAIN: Record<string, Record<string, string>> = {
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

function sourcesFor(
  config: SessionCatalogConfig,
): SnapshotSources<CatalogProfile> {
  return {
    connections: catalogConnections(config.profiles, undefined),
    allowUnattended: true,
    runtimeSupported: () => true,
    materialize: (id, definition) => {
      const profile = resolveSessionCatalog(
        { profiles: { [id]: definition }, repositories: {} },
        () => PLACEHOLDER,
      ).profiles[id];
      if (!profile) throw new Error(`no ${id}`);
      return profile;
    },
  };
}

integration("profiles.yaml imported into PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "profile_import_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const dump = () =>
    db
      .select()
      .from(installationProfiles)
      .orderBy(asc(installationProfiles.id));

  test("importing every shipped catalog twice leaves the same rows", async () => {
    const store = createPostgresInstallationProfileStore(db);
    for (const dir of CATALOGS) {
      const config = await readCatalogConfig(join(DEFAULT_CONFIG_DIR, dir));
      await importCatalogProfiles(store, config, quiet);
    }
    const first = await dump();
    for (const dir of CATALOGS) {
      const config = await readCatalogConfig(join(DEFAULT_CONFIG_DIR, dir));
      const again = await importCatalogProfiles(store, config, quiet);
      expect(again).toEqual({ inserted: [], conflicts: [] });
    }
    const second = await dump();
    console.log(
      `import twice: ${first.length} rows, then ${second.length}; equal=${JSON.stringify(first) === JSON.stringify(second)}`,
    );
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  for (const dir of CATALOGS) {
    test(`${dir}: the database path gives the YAML path's profiles, pins and revision`, async () => {
      const config = await readCatalogConfig(join(DEFAULT_CONFIG_DIR, dir));
      // What the YAML-only image (main 9afaf942) resolves.
      const stageZero = resolveSessionCatalog(config, () => PLACEHOLDER);
      const store = createPostgresInstallationProfileStore(db);
      await importCatalogProfiles(store, config, quiet);
      const rows = (await store.listAll()).filter((row) =>
        Object.hasOwn(config.profiles, row.id),
      );
      const yaml = installationProfileSnapshot(
        sourcesFor(config),
        catalogRows(config.profiles),
      );
      const fromDatabase = installationProfileSnapshot(
        sourcesFor(config),
        rows,
      );
      expect(fromDatabase.profiles).toEqual(yaml.profiles);
      expect(fromDatabase.profiles).toEqual(stageZero.profiles);
      for (const [id, profile] of Object.entries(stageZero.profiles)) {
        const stored = fromDatabase.profiles[id];
        if (!stored) throw new Error(`${dir}: no ${id}`);
        expect(profilePins(stored)).toEqual(profilePins(profile));
        expect(profileModels(stored)).toEqual(profileModels(profile));
        expect(profileFingerprint(stored)).toBe(profileFingerprint(profile));
        expect(runtimeConfigOf(stored, "tok", true)).toEqual(
          runtimeConfigOf(profile, "tok", true),
        );
        const version: WorkspaceProfileRecord = {
          id: `ws_acme_${id}_v1`,
          workspace_id: "w",
          name: id,
          version: 1,
          base_profile_id: id,
          base_fingerprint: profileFingerprint(profile),
          model: profile.model,
          models: [profile.model],
          tools: profile.tools.slice(0, 1),
          permission_mode: profile.permission_mode,
          base_runtime_version: profile.runtime_version,
          base_billing: "metered",
          base_repository_mode: "required",
          created_by: "019a0000-0000-7000-8000-0000000000b1",
          created_at: new Date(),
          retired_by: null,
          retired_at: null,
        };
        expect(
          workspaceProfileState({ profiles: fromDatabase.profiles }, version),
        ).toBe("usable");
      }
      for (const [id, digest] of Object.entries(ON_MAIN[dir] ?? {})) {
        const stored = fromDatabase.profiles[id];
        if (!stored) throw new Error(`${dir}: no ${id}`);
        expect(profilePinned(stored, digest)).toBe(true);
      }
      const revision = (profiles: typeof fromDatabase) =>
        catalogRevision({
          ...profiles,
          repositories: stageZero.repositories,
        });
      expect(revision(fromDatabase)).toBe(catalogRevision(stageZero));
      expect(revision(yaml)).toBe(catalogRevision(stageZero));
    });
  }

  test("a restarted replica reads the same profiles and revision", async () => {
    const config = await readCatalogConfig(
      join(DEFAULT_CONFIG_DIR, "fake-model"),
    );
    const store = createPostgresInstallationProfileStore(db);
    const boot = async () => {
      await importCatalogProfiles(store, config, quiet);
      const registry = createProfileRegistry({
        workspaces: schema.createPostgresWorkspaceProfileStore(db),
        installations: store,
        sources: sourcesFor(config),
      });
      await registry.refresh();
      const catalog = profileCatalog(
        resolveSessionCatalog(config, () => PLACEHOLDER),
        registry,
      );
      return {
        rows: await dump(),
        profiles: catalog.profiles,
        revision: catalogRevision(catalog),
      };
    };
    const first = await boot();
    const second = await boot();
    expect(second).toEqual(first);
  });

  test("the slack role leaves a bypass ceiling out while the switch is off", async () => {
    const config = await readCatalogConfig(
      join(DEFAULT_CONFIG_DIR, "fake-model-unattended"),
    );
    await importCatalogProfiles(
      createPostgresInstallationProfileStore(db),
      config,
      quiet,
    );
    const connections = catalogConnections(config.profiles, undefined);
    const off = slackProfileCatalog(db, config, connections, {});
    const on = slackProfileCatalog(db, config, connections, {
      [ALLOW_UNATTENDED_SETTING]: "true",
    });
    await Promise.all([
      off.workspace_profiles.refresh(),
      on.workspace_profiles.refresh(),
    ]);
    expect(off.installation.get("claude-coding-bypass")?.state).toBe(
      "unattended_off",
    );
    expect(catalogProfile(off, "claude-coding-bypass")).toBeUndefined();
    expect(allowedRun(off, "claude-coding-bypass", "sample-app")).toBeNull();
    expect(catalogProfile(on, "claude-coding-bypass")).toBeDefined();
    expect(catalogProfile(off, "claude-coding-auto")).toBeDefined();
  });

  test("import --check is clean only when the YAML and the rows agree", async () => {
    const dir = join(DEFAULT_CONFIG_DIR, "local-model");
    const config = await readCatalogConfig(dir);
    const repositories = resolveSessionCatalog(
      config,
      () => PLACEHOLDER,
    ).repositories;
    const store = createPostgresInstallationProfileStore(db);
    const check = async (own: SessionCatalogConfig["profiles"]) =>
      checkCatalogImport({
        own,
        sources: sourcesFor({ ...config, profiles: own }),
        repositories,
        rows: (await store.listAll()).filter((row) =>
          Object.hasOwn(config.profiles, row.id),
        ),
      });
    await importCatalogProfiles(store, config, quiet);
    const clean = await check(config.profiles);
    expect(importCheckClean(clean)).toBe(true);
    expect(clean.yamlRevision).toBe(clean.databaseRevision);

    const [first] = Object.keys(config.profiles).sort();
    const firstProfile =
      first === undefined ? undefined : config.profiles[first];
    if (!first || !firstProfile) throw new Error("no profile");
    const { [first]: _dropped, ...rest } = config.profiles;
    const fewer = await check(rest);
    expect(fewer.databaseOnly).toEqual([first]);
    expect(importCheckClean(fewer)).toBe(false);

    const edited = await check({
      ...config.profiles,
      [first]: { ...firstProfile, tools: [] },
    });
    expect(edited.conflicts).toEqual([
      { id: first, origin: "catalog", fields: ["tools"] },
    ]);
    expect(importCheckClean(edited)).toBe(false);

    const added = await check({
      ...config.profiles,
      "not-imported": firstProfile,
    });
    expect(added.yamlOnly).toEqual(["not-imported"]);

    const rows = (await store.listAll()).filter((row) =>
      Object.hasOwn(config.profiles, row.id),
    );
    const drifted = checkCatalogImport({
      own: config.profiles,
      sources: sourcesFor(config),
      repositories,
      rows: rows.map((row) =>
        row.id === first ? { ...row, fingerprint: "sha256:edited" } : row,
      ),
    });
    expect(drifted.conflicts).toEqual([]);
    expect(drifted.databaseRevision).not.toBe(drifted.yamlRevision);
    expect(importCheckClean(drifted)).toBe(false);
  });

  test("connections-from-yaml writes a file every profile's provider is a connection in", async () => {
    const config = await readCatalogConfig(DEFAULT_CONFIG_DIR);
    const dir = await mkdtemp(join(tmpdir(), "connections-"));
    try {
      await writeFile(
        join(dir, CONNECTIONS_FILE),
        connectionsFromProfiles(config.profiles),
      );
      const connections = await readConnections(dir);
      if (!connections) throw new Error("no connections");
      const snapshot = installationProfileSnapshot(
        { ...sourcesFor(config), connections },
        catalogRows(config.profiles),
      );
      expect(
        [...snapshot.installation.values()].every(
          (entry) => entry.state === "usable",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
