import { randomUUID } from "node:crypto";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "@werft-ai/platform";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { lockedRole } from "./api-keys.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  catalogRepositories,
  installationProfiles,
  receipts,
  workspaces,
} from "./schema.ts";

type Row = typeof catalogRepositories.$inferSelect;

function rowOf(row: Row): CatalogRepositoryRow {
  return {
    id: row.id,
    github_repository_id: row.githubRepositoryId,
    owner: row.owner,
    name: row.name,
    url: row.url,
    branch: row.branch,
    profiles: row.profiles ?? null,
    source: row.source === "seed" ? "seed" : "console",
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// The seed and every console write take it, so an id is decided by one
// writer at a time.
const lockWrites = (tx: Database) =>
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('catalog-repositories'))`,
  );

const managerOf = async (tx: Database, workspaceId: string, userId: string) => {
  // A demotion or disable committed after the policy's check wins.
  const role = await lockedRole(tx, workspaceId, userId);
  return role === "owner" || role === "admin";
};

async function receipt(
  tx: Database,
  input: {
    workspaceId: string;
    /** Null for the seed, which no one asked for. */
    actor: ReceiptActor | null;
    requestId: string | null;
    receiptId?: string;
    operation:
      | "add_repository"
      | "set_repository_branch"
      | "remove_repository"
      | "import_repository";
    result: Record<string, unknown>;
  },
) {
  await tx.insert(receipts).values({
    id: input.receiptId ?? randomUUID(),
    ownerId: input.workspaceId,
    actor: input.actor,
    operation: input.operation,
    targetRef: {
      resource: { kind: "workspace", id: input.workspaceId },
      workspace_id: input.workspaceId,
    },
    result: input.result,
    status: "succeeded",
    requestId: input.requestId,
  });
}

const auditOf = (row: CatalogRepositoryRow) => ({
  repository_id: row.id,
  full_name: `${row.owner}/${row.name}`,
  url: row.url,
  branch: row.branch,
});

export function createPostgresCatalogRepositoryStore(
  db: Database,
): CatalogRepositoryStore {
  const listActive = async () => {
    const rows = await db
      .select()
      .from(catalogRepositories)
      .where(isNull(catalogRepositories.removedAt))
      .orderBy(asc(catalogRepositories.id));
    return rows.map(rowOf);
  };
  return {
    listActive,

    // One snapshot: a seed committing between two reads would otherwise
    // read as "seeded, with no rows".
    readCatalog() {
      return db.transaction(
        async (tx) => {
          const rows = await tx
            .select()
            .from(catalogRepositories)
            .orderBy(asc(catalogRepositories.id));
          if (rows.length === 0) return null;
          return rows.filter((row) => row.removedAt === null).map(rowOf);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    seed(input) {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        const [any] = await tx
          .select({ id: catalogRepositories.id })
          .from(catalogRepositories)
          .limit(1);
        if (any) return [];
        const entries = await input.entries();
        if (entries.length === 0) return [];
        const inserted = await tx
          .insert(catalogRepositories)
          .values(
            entries.map((entry) => ({
              id: entry.id,
              owner: entry.owner,
              name: entry.name,
              url: entry.url,
              branch: entry.branch,
              profiles: entry.profiles,
              source: "seed",
            })),
          )
          .returning();
        // Before bootstrap there is no workspace to keep a receipt for.
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .limit(1);
        if (workspace) {
          for (const row of inserted) {
            await receipt(tx, {
              workspaceId: workspace.id,
              actor: null,
              requestId: null,
              operation: "import_repository",
              result: { ...auditOf(rowOf(row)), source: "seed" },
            });
          }
        }
        return inserted.map((row) => row.id).sort();
      });
    },

    add(input) {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        if (!(await managerOf(tx, input.workspaceId, input.userId))) {
          return { outcome: "actor_inactive" as const };
        }
        const [held] = await tx
          .select({ id: catalogRepositories.id })
          .from(catalogRepositories)
          .where(
            and(
              isNull(catalogRepositories.removedAt),
              sql`(${catalogRepositories.githubRepositoryId} = ${input.githubRepositoryId} OR (lower(${catalogRepositories.owner}) = lower(${input.owner}) AND lower(${catalogRepositories.name}) = lower(${input.name})))`,
            ),
          )
          .limit(1);
        if (held) return { outcome: "already_added" as const };
        // Removed rows keep their id: none is ever handed out twice.
        const taken = new Set(
          (
            await tx
              .select({ id: catalogRepositories.id })
              .from(catalogRepositories)
          ).map((row) => row.id),
        );
        const free = (id: string) => !taken.has(id) && !input.reserved.has(id);
        let id: string;
        if ("exact" in input.id) {
          if (!free(input.id.exact)) return { outcome: "id_taken" as const };
          id = input.id.exact;
        } else {
          const { base } = input.id;
          let n = 1;
          id = base;
          while (!free(id)) {
            n += 1;
            id = `${base}-${n}`;
          }
        }
        const [row] = await tx
          .insert(catalogRepositories)
          .values({
            id,
            githubRepositoryId: input.githubRepositoryId,
            owner: input.owner,
            name: input.name,
            url: input.url,
            branch: input.branch,
            source: "console",
            createdBy: input.userId,
            updatedBy: input.userId,
          })
          .returning();
        if (!row) throw new Error("catalog repository insert returned no row");
        const repository = rowOf(row);
        await receipt(tx, {
          workspaceId: input.workspaceId,
          actor: input.actor,
          requestId: input.requestId,
          receiptId: input.receiptId,
          operation: "add_repository",
          result: auditOf(repository),
        });
        return { outcome: "stored" as const, repository };
      });
    },

    setBranch(input) {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        if (!(await managerOf(tx, input.workspaceId, input.userId))) {
          return { outcome: "actor_inactive" as const };
        }
        const [held] = await tx
          .select()
          .from(catalogRepositories)
          .where(
            and(
              eq(catalogRepositories.id, input.id),
              isNull(catalogRepositories.removedAt),
            ),
          )
          .limit(1);
        if (!held) return { outcome: "not_found" as const };
        if (held.version !== input.version) {
          return { outcome: "revision_conflict" as const };
        }
        const [row] = await tx
          .update(catalogRepositories)
          .set({
            branch: input.branch,
            version: held.version + 1,
            updatedBy: input.userId,
            updatedAt: sql`now()`,
          })
          .where(eq(catalogRepositories.id, input.id))
          .returning();
        if (!row) throw new Error("catalog repository update returned no row");
        const repository = rowOf(row);
        await receipt(tx, {
          workspaceId: input.workspaceId,
          actor: input.actor,
          requestId: input.requestId,
          receiptId: input.receiptId,
          operation: "set_repository_branch",
          result: {
            ...auditOf(repository),
            before: held.branch,
            version: repository.version,
          },
        });
        return { outcome: "stored" as const, repository };
      });
    },

    remove(input) {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        if (!(await managerOf(tx, input.workspaceId, input.userId))) {
          return { outcome: "actor_inactive" as const };
        }
        const [held] = await tx
          .select()
          .from(catalogRepositories)
          .where(
            and(
              eq(catalogRepositories.id, input.id),
              isNull(catalogRepositories.removedAt),
            ),
          )
          .limit(1);
        if (!held) return { outcome: "not_found" as const };
        const profiles = await tx
          .select({ id: installationProfiles.id })
          .from(installationProfiles)
          .where(
            and(
              isNull(installationProfiles.retiredAt),
              sql`${installationProfiles.repositoryIds} ? ${input.id}`,
            ),
          )
          .orderBy(asc(installationProfiles.id));
        const using = await tx
          .select({ slug: agents.slug })
          .from(agents)
          .innerJoin(
            agentReleases,
            eq(agentReleases.id, agents.activeReleaseId),
          )
          .where(
            and(
              isNotNull(agents.activeReleaseId),
              sql`(${agentReleases.repositoryId} = ${input.id} OR coalesce(${agentReleases.policyPins} -> 'github' -> 'repositories', '[]'::jsonb) ? ${input.id})`,
            ),
          )
          .orderBy(asc(agents.slug));
        if (profiles.length > 0 || using.length > 0) {
          return {
            outcome: "in_use" as const,
            profiles: profiles.map((row) => row.id),
            agents: using.map((row) => row.slug),
          };
        }
        await tx
          .update(catalogRepositories)
          .set({ removedAt: sql`now()`, removedBy: input.userId })
          .where(eq(catalogRepositories.id, input.id));
        await receipt(tx, {
          workspaceId: input.workspaceId,
          actor: input.actor,
          requestId: input.requestId,
          receiptId: input.receiptId,
          operation: "remove_repository",
          result: auditOf(rowOf(held)),
        });
        return { outcome: "removed" as const };
      });
    },
  };
}
