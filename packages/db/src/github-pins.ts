import type { GitHubPinStore, GitHubRepositoryPin } from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import { DB_NOW } from "./db-clock.ts";
import { lockGitHubApps } from "./github-apps.ts";
import type { Database } from "./queries.ts";
import { catalogRepositoryGitHubApps, githubApps, receipts } from "./schema.ts";

type Row = typeof catalogRepositoryGitHubApps.$inferSelect;

const pinOf = (row: Row): GitHubRepositoryPin => ({
  repositoryId: row.repositoryId,
  role: row.role,
  connectionId: row.connectionId,
  appId: row.appId,
  pinnedBy: row.pinnedBy,
});

const keyOf = (repositoryId: string, role: Row["role"]) =>
  and(
    eq(catalogRepositoryGitHubApps.repositoryId, repositoryId),
    eq(catalogRepositoryGitHubApps.role, role),
  );

function pinReceipt(input: {
  id: string;
  ownerId: string;
  actor: unknown;
  repositoryId: string;
  role: Row["role"];
  pinnedBy: "selection" | "admin";
  before: string | null;
  after: string;
}) {
  return {
    id: input.id,
    ownerId: input.ownerId,
    actor: input.actor as typeof receipts.$inferInsert.actor,
    operation: "set_repository_github_app",
    targetRef: {
      resource: { kind: "workspace", id: input.ownerId },
      workspace_id: input.ownerId,
    },
    status: "succeeded" as const,
    result: {
      repository_id: input.repositoryId,
      role: input.role,
      pinned_by: input.pinnedBy,
      before: input.before,
      after: input.after,
    },
  };
}

export function createPostgresGitHubPinStore(db: Database): GitHubPinStore {
  return {
    async get(repositoryId, role) {
      const [row] = await db
        .select()
        .from(catalogRepositoryGitHubApps)
        .where(keyOf(repositoryId, role))
        .limit(1);
      return row ? pinOf(row) : null;
    },

    async list() {
      const rows = await db.select().from(catalogRepositoryGitHubApps);
      return rows.map(pinOf);
    },

    pinFirst(input) {
      return db.transaction(async (tx) => {
        const connectionId = input.connectionId.toLowerCase();
        const held = async () => {
          const [row] = await tx
            .select()
            .from(catalogRepositoryGitHubApps)
            .where(keyOf(input.repositoryId, input.role))
            .limit(1);
          return { pin: row ? pinOf(row) : null, created: false };
        };
        const [owner] = await tx
          .select({ workspaceId: githubApps.workspaceId })
          .from(githubApps)
          .where(eq(githubApps.id, connectionId));
        if (owner === undefined) return held();
        // Under the writers' lock, so a replacement cannot land between
        // this check and the insert.
        await lockGitHubApps(tx, owner.workspaceId);
        const [still] = await tx
          .select({ id: githubApps.id })
          .from(githubApps)
          .where(
            and(
              eq(githubApps.id, connectionId),
              eq(githubApps.role, input.role),
              eq(githubApps.appId, input.appId),
            ),
          );
        if (still === undefined) return held();
        const inserted = await tx
          .insert(catalogRepositoryGitHubApps)
          .values({
            repositoryId: input.repositoryId,
            role: input.role,
            connectionId,
            appId: input.appId,
            pinnedBy: input.pinnedBy,
            updatedBy: input.audit?.actor.actor_user_id ?? null,
          })
          .onConflictDoNothing()
          .returning();
        const [created] = inserted;
        if (created !== undefined) {
          if (input.audit !== undefined && input.pinnedBy === "selection") {
            await tx.insert(receipts).values(
              pinReceipt({
                id: input.audit.receiptId,
                ownerId: input.audit.ownerId,
                actor: input.audit.actor,
                repositoryId: input.repositoryId,
                role: input.role,
                pinnedBy: "selection",
                before: null,
                after: connectionId,
              }),
            );
          }
          return { pin: pinOf(created), created: true };
        }
        const kept = await held();
        if (kept.pin === null) throw new Error("GitHub pin vanished");
        return kept;
      });
    },

    set(input) {
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        await lockGitHubApps(tx, workspaceId);
        const [connection] = await tx
          .select({
            id: githubApps.id,
            role: githubApps.role,
            appId: githubApps.appId,
          })
          .from(githubApps)
          .where(
            and(
              eq(githubApps.workspaceId, workspaceId),
              eq(githubApps.id, input.connectionId.toLowerCase()),
            ),
          );
        if (connection === undefined) return { outcome: "not_found" as const };
        if (connection.role !== input.role) {
          return { outcome: "role_mismatch" as const };
        }
        const [held] = await tx
          .select()
          .from(catalogRepositoryGitHubApps)
          .where(keyOf(input.repositoryId, input.role))
          .for("update")
          .limit(1);
        const before = held?.connectionId ?? null;
        if (held !== undefined && before === connection.id) {
          return { outcome: "stored" as const, before, changed: false };
        }
        await tx
          .insert(catalogRepositoryGitHubApps)
          .values({
            repositoryId: input.repositoryId,
            role: input.role,
            connectionId: connection.id,
            appId: connection.appId,
            pinnedBy: "admin",
            updatedBy: input.actor.actor_user_id,
          })
          .onConflictDoUpdate({
            target: [
              catalogRepositoryGitHubApps.repositoryId,
              catalogRepositoryGitHubApps.role,
            ],
            set: {
              connectionId: connection.id,
              appId: connection.appId,
              pinnedBy: "admin",
              updatedBy: input.actor.actor_user_id,
              updatedAt: DB_NOW,
            },
          });
        await tx.insert(receipts).values(
          pinReceipt({
            id: input.receiptId,
            ownerId: workspaceId,
            actor: input.actor,
            repositoryId: input.repositoryId,
            role: input.role,
            pinnedBy: "admin",
            before,
            after: connection.id,
          }),
        );
        return { outcome: "stored" as const, before, changed: true };
      });
    },
  };
}
