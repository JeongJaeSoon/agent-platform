import { canonicalJson } from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type CatalogRepository,
  type CatalogRepositoryStore,
  type CatalogSeedResult,
  type Connections,
  catalogImports,
  catalogRepositoryIds,
  type InstallationProfileStore,
  type InstallationSettingsStore,
  repoRefOf,
  type SeedRepository,
  type SessionCatalogConfig,
  type SettingsImport,
} from "@werft-ai/platform";
import { stringify as stringifyYaml } from "yaml";
import { readSeedProfiles } from "./catalog-config.ts";

/** `profiles.yaml` could not seed an empty table; retrying will not fix it. */
export class SeedProfilesError extends Error {
  override name = "SeedProfilesError";
}

/**
 * Seeds an empty `installation_profiles` from `profiles.yaml`, as the api
 * role does before it reads the registry, and moves the repositories.yaml
 * allow lists of imported rows that predate the database holding them. A
 * filled table never opens `profiles.yaml`.
 */
export async function seedCatalogProfiles(
  store: Pick<InstallationProfileStore, "seedCatalog">,
  input: { dir: string; config: SessionCatalogConfig },
  logger: Pick<StructuredLogger, "info">,
): Promise<CatalogSeedResult> {
  const result = await store.seedCatalog({
    entries: async () => {
      try {
        return catalogImports(await readSeedProfiles(input.dir, input.config));
      } catch (error) {
        throw new SeedProfilesError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    repositoryIdsOf: catalogRepositoryIds(input.config.repositories),
  });
  if (result.seeded.length > 0) {
    logger.info("Profiles seeded", { profiles: result.seeded });
  }
  if (result.migrated.length > 0) {
    logger.info("Profile repositories moved to the database", {
      profiles: result.migrated,
    });
  }
  return result;
}

/**
 * Seeds an empty `catalog_repositories` from the `{ kind: github_app }`
 * entries of repositories.yaml. A filled table is never seeded again, so a
 * repository the console removed does not come back.
 */
export async function seedCatalogRepositories(
  store: Pick<CatalogRepositoryStore, "seed">,
  repositories: Readonly<Record<string, CatalogRepository>>,
  logger: Pick<StructuredLogger, "info" | "warn">,
): Promise<void> {
  const seeded = await store.seed({
    entries: async () => {
      const entries: SeedRepository[] = [];
      // One row per GitHub repository (the table's unique key): a second
      // yaml id on the same repository would fail the whole seed.
      const seen = new Map<string, string>();
      for (const [id, repository] of Object.entries(repositories)) {
        const auth = repository.auth;
        if (auth?.kind !== "github_app" || !("registered" in auth)) continue;
        const ref = repoRefOf(repository.url);
        if (ref === null) {
          logger.warn("Repository left out of the seed: not a GitHub URL", {
            repository: id,
          });
          continue;
        }
        const fullName = `${ref.owner}/${ref.name}`.toLowerCase();
        const first = seen.get(fullName);
        if (first !== undefined) {
          logger.warn(
            "Repository left out of the seed: another id already seeds that GitHub repository",
            { repository: id, seeded_as: first },
          );
          continue;
        }
        seen.set(fullName, id);
        entries.push({
          id,
          owner: ref.owner,
          name: ref.name,
          url: repository.url,
          branch: repository.branch,
          profiles: repository.profiles ? [...repository.profiles] : null,
        });
      }
      return entries;
    },
  });
  if (seeded.length > 0) {
    logger.info("Repositories seeded", { repositories: seeded });
  }
}

/**
 * Brings the operator files' connections, credential-holding repositories
 * and MCP servers into the database, each id once: a row already there is
 * kept, and named when the file now says something else.
 */
export async function importFileSettings(
  store: Pick<InstallationSettingsStore, "importSettings">,
  entries: SettingsImport,
  logger: Pick<StructuredLogger, "info" | "warn">,
): Promise<void> {
  const { inserted, conflicts } = await store.importSettings(entries);
  if (inserted.length > 0) {
    logger.info("Installation settings imported from the files", {
      entries: inserted,
    });
  }
  if (conflicts.length > 0) {
    logger.warn(
      "The files differ from the installation settings for these ids; the database's are kept",
      { entries: conflicts },
    );
  }
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
