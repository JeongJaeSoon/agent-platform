import { canonicalJson } from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type CatalogSeedResult,
  type Connections,
  catalogImports,
  catalogRepositoryIds,
  type InstallationProfileStore,
  type SessionCatalogConfig,
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
