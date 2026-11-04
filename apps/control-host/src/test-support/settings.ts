import {
  createPostgresCatalogRepositoryStore,
  createPostgresInstallationProfileStore,
  createPostgresInstallationSettingsStore,
  createPostgresSettingsDocumentStore,
  createPostgresWorkspaceProfileStore,
  type Database,
} from "@werft-ai/db";
import {
  catalogImports,
  catalogRepositoryIds,
  parseSeedDocument,
  type SessionCatalog,
} from "@werft-ai/platform";
import { parse } from "yaml";
import { databaseCatalog } from "../api/catalog-config.ts";

/** A settings document from YAML sections; the ones left out stay empty. */
export function settingsDocument(...sections: readonly string[]) {
  return Object.assign(
    { version: 1, connections: {}, repositories: {}, mcp_servers: {} },
    ...sections.map((section) => parse(section)),
  );
}

/** What migrate's `settings import` leaves in the database. */
export async function seedSettings(
  db: Database,
  document: unknown,
): Promise<void> {
  const seed = parseSeedDocument(document);
  const result = await createPostgresSettingsDocumentStore(db).importEntries(
    seed.entries,
    { dryRun: false, allowExternal: true, actor: null },
  );
  if (result.outcome !== "applied") {
    throw new Error(`settings import ${result.outcome}`);
  }
  if (seed.profiles === null) return;
  const { profiles } = seed;
  await createPostgresInstallationProfileStore(db).seedCatalog({
    entries: async () => catalogImports(profiles),
    repositoryIdsOf: catalogRepositoryIds(seed.entries.repositories),
  });
}

/** The session catalog the API serves from those rows. */
export function settingsCatalog(
  db: Database,
  env: Record<string, string | undefined> = {},
): Promise<SessionCatalog> {
  return databaseCatalog({
    installations: createPostgresInstallationProfileStore(db),
    workspaces: createPostgresWorkspaceProfileStore(db),
    repositories: createPostgresCatalogRepositoryStore(db),
    settings: createPostgresInstallationSettingsStore(db, null),
    credential: () => "api-side-only",
    env,
  });
}
