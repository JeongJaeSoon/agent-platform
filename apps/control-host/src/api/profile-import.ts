import { canonicalJson } from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type CatalogImportResult,
  type CatalogProfileView,
  type CatalogRepository,
  type Connections,
  catalogImports,
  catalogRevision,
  catalogRows,
  differingDefinitionFields,
  type InstallationProfileRecord,
  type InstallationProfileStore,
  installationProfileSnapshot,
  type SessionCatalogConfig,
  type SnapshotSources,
} from "@werft-ai/platform";
import { stringify as stringifyYaml } from "yaml";

/**
 * Puts each `profiles.yaml` id absent from `installation_profiles` in it,
 * as the api role does before it reads the registry. Never overwrites.
 */
export async function importCatalogProfiles(
  store: Pick<InstallationProfileStore, "importCatalog">,
  config: Pick<SessionCatalogConfig, "profiles">,
  logger: Pick<StructuredLogger, "info" | "warn">,
): Promise<CatalogImportResult> {
  const result = await store.importCatalog(catalogImports(config.profiles));
  if (result.inserted.length > 0) {
    logger.info("Profiles imported", { profiles: result.inserted });
  }
  for (const conflict of result.conflicts) {
    logger.warn("Profile import conflict", {
      profile_id: conflict.id,
      origin: conflict.origin,
      fields: conflict.fields,
    });
  }
  return result;
}

export type ImportCheck = {
  conflicts: CatalogImportResult["conflicts"];
  /** `catalog` rows this YAML does not have. */
  databaseOnly: string[];
  /** YAML ids the database does not have yet. */
  yamlOnly: string[];
  /** Rows whose provider is none of this replica's connections. */
  connectionMissing: string[];
  yamlRevision: string;
  databaseRevision: string;
};

/**
 * What `profiles import --check` reports for one replica's config against
 * the rows: clean only when a rollback to this image, or to the YAML-only
 * one, sees the same profiles and the same revision.
 */
export function checkCatalogImport<P extends CatalogProfileView>(input: {
  /** This replica's `profiles.yaml`. */
  own: SessionCatalogConfig["profiles"];
  sources: SnapshotSources<P>;
  repositories: Record<string, CatalogRepository>;
  rows: readonly InstallationProfileRecord[];
}): ImportCheck {
  const { sources, rows } = input;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const conflicts = catalogImports(input.own).flatMap((entry) => {
    const row = byId.get(entry.id);
    if (!row) return [];
    const fields = differingDefinitionFields(row.definition, entry.definition);
    return row.origin === "console" || fields.length > 0
      ? [{ id: entry.id, origin: row.origin, fields }]
      : [];
  });
  const own = new Set(Object.keys(input.own));
  const databaseOnly = rows
    .filter((row) => row.origin === "catalog" && !own.has(row.id))
    .map((row) => row.id);
  const yamlOnly = [...own].filter((id) => !byId.has(id)).sort();
  const fromDatabase = installationProfileSnapshot(sources, rows);
  const connectionMissing = [...fromDatabase.installation.values()]
    .filter((entry) => entry.state === "connection_missing")
    .map((entry) => entry.id);
  const revisionOf = (snapshot: typeof fromDatabase) =>
    catalogRevision({
      profiles: snapshot.profiles,
      installation: snapshot.installation,
      repositories: input.repositories,
    });
  return {
    conflicts,
    databaseOnly,
    yamlOnly,
    connectionMissing,
    yamlRevision: revisionOf(
      installationProfileSnapshot(sources, catalogRows(input.own)),
    ),
    databaseRevision: revisionOf(fromDatabase),
  };
}

export function importCheckClean(check: ImportCheck): boolean {
  return (
    check.conflicts.length === 0 &&
    check.databaseOnly.length === 0 &&
    check.yamlOnly.length === 0 &&
    check.connectionMissing.length === 0 &&
    check.yamlRevision === check.databaseRevision
  );
}

/**
 * `connections.yaml` holding every provider `profiles.yaml` names, one
 * connection per distinct provider under the first profile id using it.
 */
export function connectionsFromProfiles(
  profiles: SessionCatalogConfig["profiles"],
): string {
  const connections: Record<string, Connections[string]> = {};
  const seen = new Set<string>();
  for (const id of Object.keys(profiles).sort()) {
    const provider = profiles[id]?.provider;
    if (!provider || seen.has(canonicalJson(provider))) continue;
    seen.add(canonicalJson(provider));
    connections[id] = provider;
  }
  return stringifyYaml({ connections });
}
