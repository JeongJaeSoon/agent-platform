import type { PermissionMode } from "@werft-ai/contracts";
import {
  differingDefinitionFields,
  type InstallationProfileRecord,
  type InstallationProfileStore,
} from "@werft-ai/platform";
import { asc, inArray, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { installationProfiles } from "./schema.ts";

function recordOf(
  row: typeof installationProfiles.$inferSelect,
): InstallationProfileRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    origin: row.origin as InstallationProfileRecord["origin"],
    definition: row.definition,
    permission_mode: row.permissionMode as PermissionMode,
    fingerprint: row.fingerprint,
    repository_ids: row.repositoryIds,
    previous_id: row.previousId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    retired_at: row.retiredAt,
    retired_by: row.retiredBy,
  };
}

export function createPostgresInstallationProfileStore(
  db: Database,
): InstallationProfileStore {
  return {
    async listAll() {
      const rows = await db
        .select()
        .from(installationProfiles)
        .orderBy(asc(installationProfiles.id));
      return rows.map(recordOf);
    },

    async importCatalog(entries) {
      if (entries.length === 0) return { inserted: [], conflicts: [] };
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('profiles:import'))`,
        );
        const inserted = await tx
          .insert(installationProfiles)
          .values(
            entries.map((entry) => ({
              id: entry.id,
              name: null,
              version: 1,
              origin: "catalog",
              definition: entry.definition as Record<string, unknown>,
              permissionMode: entry.permission_mode,
              fingerprint: entry.fingerprint,
              repositoryIds: [],
            })),
          )
          .onConflictDoNothing({ target: installationProfiles.id })
          .returning({ id: installationProfiles.id });
        const fresh = new Set(inserted.map((row) => row.id));
        const kept = entries.filter((entry) => !fresh.has(entry.id));
        const existing =
          kept.length === 0
            ? []
            : await tx
                .select()
                .from(installationProfiles)
                .where(
                  inArray(
                    installationProfiles.id,
                    kept.map((entry) => entry.id),
                  ),
                );
        const byId = new Map(existing.map((row) => [row.id, row]));
        const conflicts = kept.flatMap((entry) => {
          const row = byId.get(entry.id);
          if (!row) return [];
          const fields = differingDefinitionFields(
            row.definition,
            entry.definition,
          );
          return row.origin === "console" || fields.length > 0
            ? [
                {
                  id: entry.id,
                  origin: row.origin as InstallationProfileRecord["origin"],
                  fields,
                },
              ]
            : [];
        });
        return { inserted: [...fresh].sort(), conflicts };
      });
    },
  };
}
