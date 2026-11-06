import {
  installationProfileId,
  type PermissionMode,
} from "@werft-ai/contracts";
import type {
  InstallationProfileRecord,
  InstallationProfileStore,
  TeamActor,
} from "@werft-ai/platform";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import { lockSettingsGeneration } from "./installation-settings.ts";
import type { Database } from "./queries.ts";
import { installationProfiles, receipts } from "./schema.ts";

// Imports and console saves take the same lock, so a version number and an
// id are decided by one writer at a time.
export const lockWrites = async (tx: Database) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('profiles:import'))`,
  );
  await lockSettingsGeneration(tx);
};

async function actorOperates(tx: Database, actor: TeamActor) {
  const [me] = await lockPeople(tx, actor.workspaceId, [actor.userId]);
  return me?.live === true && me.role === "owner";
}

async function writeReceipt(
  tx: Database,
  actor: TeamActor,
  input: {
    id: string;
    operation:
      | "create_installation_profile"
      | "retire_installation_profile"
      | "block_installation_profile"
      | "unblock_installation_profile";
    result: Record<string, unknown>;
  },
) {
  await tx.insert(receipts).values({
    id: input.id,
    ownerId: actor.principal.ownerId,
    actor: receiptActorOf(actor.principal),
    operation: input.operation,
    targetRef: {
      resource: { kind: "workspace", id: actor.workspaceId },
      workspace_id: actor.workspaceId,
    },
    result: input.result,
    status: "succeeded",
    requestId: actor.principal.requestId ?? null,
  });
}

export function recordOf(
  row: typeof installationProfiles.$inferSelect,
): InstallationProfileRecord {
  const scope = row.repositoryScope;
  // Null says nothing about repositories; any other value this image does
  // not know is unknown.
  const knownScope =
    scope === null || scope === "profile" || scope === "workspace";
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    origin: row.origin as InstallationProfileRecord["origin"],
    definition: row.definition,
    permission_mode: row.permissionMode as PermissionMode,
    fingerprint: row.fingerprint,
    repository_ids: row.repositoryIds,
    github_app_repositories:
      row.githubAppRepositories === "installed" ? "installed" : "listed",
    repository_scope: knownScope ? scope : "profile",
    derived_from: row.derivedFrom,
    workspace_id: row.workspaceId,
    display_name: row.displayName,
    deny: row.deny,
    tool_catalog_id: row.toolCatalogId,
    previous_id: row.previousId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    retired_at: row.retiredAt,
    retired_by: row.retiredBy,
    // Neither ceiling can be said to judge a scope this image does not know
    // (either could be the wider), so the profile does not run.
    blocked_at: knownScope ? row.blockedAt : (row.blockedAt ?? row.createdAt),
    blocked_by: row.blockedBy,
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

    async seedCatalog(input) {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        const [any] = await tx
          .select({ id: installationProfiles.id })
          .from(installationProfiles)
          .limit(1);
        const entries = any ? [] : await input.entries();
        const seeded =
          entries.length === 0
            ? []
            : await tx
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
                    repositoryIds: input.repositoryIdsOf(entry.id),
                  })),
                )
                .returning({ id: installationProfiles.id });
        const unmigrated = await tx
          .select({ id: installationProfiles.id })
          .from(installationProfiles)
          // A row with no scope names no repository on purpose: filling it
          // would write the repositories it leaves to the workspace.
          .where(
            and(
              isNull(installationProfiles.repositoryIds),
              isNotNull(installationProfiles.repositoryScope),
            ),
          )
          .orderBy(asc(installationProfiles.id));
        for (const { id } of unmigrated) {
          await tx
            .update(installationProfiles)
            .set({ repositoryIds: input.repositoryIdsOf(id) })
            .where(eq(installationProfiles.id, id));
        }
        return {
          seeded: seeded.map((row) => row.id).sort(),
          migrated: unmigrated.map((row) => row.id),
        };
      });
    },

    async create(input) {
      const { actor } = input;
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        if (!(await actorOperates(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [latest] = await tx
          .select({
            id: installationProfiles.id,
            version: installationProfiles.version,
          })
          .from(installationProfiles)
          .where(
            and(
              eq(installationProfiles.origin, "console"),
              eq(installationProfiles.name, input.name),
            ),
          )
          .orderBy(desc(installationProfiles.version))
          .limit(1);
        if (latest) {
          if (input.previousId !== latest.id) {
            return { outcome: "stale_previous" as const, latestId: latest.id };
          }
        }
        let inherited: string | null = null;
        if (input.previousId !== null) {
          const [previous] = await tx
            .select({
              githubAppRepositories: installationProfiles.githubAppRepositories,
            })
            .from(installationProfiles)
            .where(eq(installationProfiles.id, input.previousId));
          if (!previous) return { outcome: "unknown_previous" as const };
          inherited = previous.githubAppRepositories;
        }
        const version = (latest?.version ?? 0) + 1;
        const id = installationProfileId(input.name, version);
        const [taken] = await tx
          .select({ id: installationProfiles.id })
          .from(installationProfiles)
          .where(eq(installationProfiles.id, id));
        if (taken) return { outcome: "id_taken" as const, id };
        const [row] = await tx
          .insert(installationProfiles)
          .values({
            id,
            name: input.name,
            version,
            origin: "console",
            definition: input.definition as Record<string, unknown>,
            permissionMode: input.permission_mode,
            fingerprint: input.fingerprint,
            repositoryIds: input.repository_ids,
            githubAppRepositories:
              input.github_app_repositories ?? inherited ?? "listed",
            deny: input.deny,
            toolCatalogId: input.toolCatalogId,
            previousId: input.previousId,
            createdBy: actor.userId,
          })
          .returning();
        if (!row)
          throw new Error("installation profile insert returned no row");
        const record = recordOf(row);
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: "create_installation_profile",
          result: {
            profile_id: record.id,
            name: record.name,
            version: record.version,
            previous_id: record.previous_id,
            fingerprint: record.fingerprint,
            permission_mode: record.permission_mode,
            connection_id: input.connectionId,
            repository_ids: record.repository_ids,
            github_app_repositories: record.github_app_repositories,
            deny: record.deny ?? null,
            tool_catalog_id: record.tool_catalog_id ?? null,
            ...(input.previousDenyDrift ? { previous_deny_drift: true } : {}),
          },
        });
        return { outcome: "created" as const, record };
      });
    },

    async retire(input) {
      const { actor } = input;
      return db.transaction(async (tx) => {
        await lockSettingsGeneration(tx);
        if (!(await actorOperates(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(installationProfiles)
          .where(eq(installationProfiles.id, input.profileId))
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if (row.retiredAt !== null) {
          return { outcome: "unchanged" as const, record: recordOf(row) };
        }
        const [retired] = await tx
          .update(installationProfiles)
          .set({ retiredAt: sql`now()`, retiredBy: actor.userId })
          .where(eq(installationProfiles.id, row.id))
          .returning();
        if (!retired) {
          throw new Error("installation profile update returned no row");
        }
        const record = recordOf(retired);
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: "retire_installation_profile",
          result: { profile_id: record.id },
        });
        return { outcome: "retired" as const, record };
      });
    },

    async setBlocked(input) {
      const { actor } = input;
      return db.transaction(async (tx) => {
        await lockSettingsGeneration(tx);
        if (!(await actorOperates(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(installationProfiles)
          .where(eq(installationProfiles.id, input.profileId))
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if ((row.blockedAt !== null) === input.blocked) {
          return { outcome: "unchanged" as const, record: recordOf(row) };
        }
        const [changed] = await tx
          .update(installationProfiles)
          .set(
            input.blocked
              ? { blockedAt: sql`now()`, blockedBy: actor.userId }
              : { blockedAt: null, blockedBy: null },
          )
          .where(eq(installationProfiles.id, row.id))
          .returning();
        if (!changed) {
          throw new Error("installation profile update returned no row");
        }
        const record = recordOf(changed);
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: input.blocked
            ? "block_installation_profile"
            : "unblock_installation_profile",
          result: { profile_id: record.id },
        });
        return { outcome: "changed" as const, record };
      });
    },
  };
}
