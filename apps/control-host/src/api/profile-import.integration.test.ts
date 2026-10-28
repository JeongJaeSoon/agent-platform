import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type Connections,
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
  PROFILES_FILE,
  readCatalogConfig,
  readConnections,
  readSeedProfiles,
} from "./catalog-config.ts";
import {
  connectionsFromProfiles,
  SeedProfilesError,
  seedCatalogProfiles,
} from "./profile-import.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const CATALOGS = [".", "fake-model", "fake-model-unattended", "local-model"];
const PLACEHOLDER = "placeholder-credential-value";
const quiet = { info: () => {} };

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

function sourcesFor(connections: Connections): SnapshotSources<CatalogProfile> {
  return {
    connections,
    repositoryIdsOf: () => [],
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

// Seeding only acts on an empty table, so each test owns a database.
async function emptyDatabase<T>(
  run: (db: NodePgDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const database = await createTempDatabase({ prefix: "profile_seed_it" });
  const pool = new Pool({ connectionString: database.url, max: 4 });
  try {
    return await run(drizzle(pool, { schema }));
  } finally {
    await pool.end();
    await database.drop();
  }
}

const dump = (db: NodePgDatabase<typeof schema>) =>
  db.select().from(installationProfiles).orderBy(asc(installationProfiles.id));

async function shipped(dir: string) {
  const path = join(DEFAULT_CONFIG_DIR, dir);
  const config = await readCatalogConfig(path);
  return {
    path,
    config,
    seed: await readSeedProfiles(path, config),
    connections: await readConnections(path),
  };
}

async function editableCopy(dir: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "profile-seed-"));
  await cp(join(DEFAULT_CONFIG_DIR, dir), copy, { recursive: true });
  return copy;
}

integration("profiles.yaml seeding an empty PostgreSQL", () => {
  for (const dir of CATALOGS) {
    test(`${dir}: the seeded database gives the YAML's profiles, pins, revision and repositories`, async () => {
      await emptyDatabase(async (db) => {
        const { path, config, seed, connections } = await shipped(dir);
        // What the YAML-only image (main 9afaf942) resolves.
        const stageZero = resolveSessionCatalog(
          { ...config, profiles: seed },
          () => PLACEHOLDER,
        );
        const store = createPostgresInstallationProfileStore(db);
        const result = await seedCatalogProfiles(
          store,
          { dir: path, config },
          quiet,
        );
        expect(result).toEqual({
          seeded: Object.keys(seed).sort(),
          migrated: [],
        });
        const fromDatabase = installationProfileSnapshot(
          sourcesFor(connections),
          await store.listAll(),
        );
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
            workspaceProfileState(
              {
                profiles: fromDatabase.profiles,
                installation: fromDatabase.installation,
              },
              version,
            ),
          ).toBe("usable");
        }
        for (const [id, digest] of Object.entries(ON_MAIN[dir] ?? {})) {
          const stored = fromDatabase.profiles[id];
          if (!stored) throw new Error(`${dir}: no ${id}`);
          expect(profilePinned(stored, digest)).toBe(true);
        }
        expect(
          catalogRevision({
            ...fromDatabase,
            repositories: stageZero.repositories,
          }),
        ).toBe(catalogRevision(stageZero));
        const catalog = {
          ...stageZero,
          profiles: fromDatabase.profiles,
          installation: fromDatabase.installation,
        };
        for (const [repositoryId, repository] of Object.entries(
          config.repositories,
        )) {
          for (const profileId of repository.profiles ?? []) {
            if (!stageZero.profiles[profileId]) continue;
            expect(allowedRun(catalog, profileId, repositoryId)).not.toBeNull();
          }
        }
      });
    }, 60_000);
  }

  test("a populated database ignores later YAML: new ids, edited entries, moved repositories, a broken file", async () => {
    await emptyDatabase(async (db) => {
      const copy = await editableCopy("fake-model");
      try {
        const store = createPostgresInstallationProfileStore(db);
        const config = await readCatalogConfig(copy);
        await seedCatalogProfiles(store, { dir: copy, config }, quiet);
        const before = await dump(db);
        await writeFile(join(copy, PROFILES_FILE), "profiles: [broken\n");
        const moved: SessionCatalogConfig = {
          ...config,
          repositories: Object.fromEntries(
            Object.entries(config.repositories).map(([id, repository]) => [
              id,
              { ...repository, profiles: [] },
            ]),
          ),
        };
        const again = await seedCatalogProfiles(
          store,
          { dir: copy, config: moved },
          quiet,
        );
        expect(again).toEqual({ seeded: [], migrated: [] });
        const after = await dump(db);
        console.log(
          `populated seed: ${before.length} rows, then ${after.length}; equal=${JSON.stringify(before) === JSON.stringify(after)}`,
        );
        expect(after).toEqual(before);
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
    });
  }, 60_000);

  test("an empty database with a profiles.yaml that does not parse refuses to seed", async () => {
    await emptyDatabase(async (db) => {
      const copy = await editableCopy("fake-model");
      try {
        await writeFile(join(copy, PROFILES_FILE), "profiles: [broken\n");
        const config = await readCatalogConfig(copy);
        const store = createPostgresInstallationProfileStore(db);
        const refused = await seedCatalogProfiles(
          store,
          { dir: copy, config },
          quiet,
        ).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(SeedProfilesError);
        expect(await dump(db)).toEqual([]);
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
    });
  }, 60_000);

  test("a restarted replica reads the same rows, profiles and revision", async () => {
    await emptyDatabase(async (db) => {
      const { path, config, connections } = await shipped("fake-model");
      const store = createPostgresInstallationProfileStore(db);
      const boot = async () => {
        await seedCatalogProfiles(store, { dir: path, config }, quiet);
        const registry = createProfileRegistry({
          workspaces: schema.createPostgresWorkspaceProfileStore(db),
          installations: store,
          sources: sourcesFor(connections),
        });
        await registry.refresh();
        const catalog = profileCatalog(
          resolveSessionCatalog(config, () => PLACEHOLDER),
          registry,
        );
        return {
          rows: await dump(db),
          profiles: catalog.profiles,
          revision: catalogRevision(catalog),
        };
      };
      const first = await boot();
      const second = await boot();
      expect(second).toEqual(first);
      expect(first.rows.length).toBeGreaterThan(0);
    });
  }, 60_000);

  test("the slack role leaves a bypass ceiling out while the switch is off", async () => {
    await emptyDatabase(async (db) => {
      const { path, config, connections } = await shipped(
        "fake-model-unattended",
      );
      await seedCatalogProfiles(
        createPostgresInstallationProfileStore(db),
        { dir: path, config },
        quiet,
      );
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
      expect(
        allowedRun(on, "claude-coding-bypass", "sample-app"),
      ).not.toBeNull();
      expect(catalogProfile(off, "claude-coding-auto")).toBeDefined();
    });
  }, 60_000);
});

test("connections-from-yaml writes a file every profile's provider is a connection in", async () => {
  const config = await readCatalogConfig(DEFAULT_CONFIG_DIR);
  const seed = await readSeedProfiles(DEFAULT_CONFIG_DIR, config);
  const dir = await mkdtemp(join(tmpdir(), "connections-"));
  try {
    await writeFile(join(dir, CONNECTIONS_FILE), connectionsFromProfiles(seed));
    const snapshot = installationProfileSnapshot(
      sourcesFor(await readConnections(dir)),
      catalogRows(seed),
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
