import { randomUUID } from "node:crypto";
import type { GitHubAppRole } from "@werft-ai/contracts";
import {
  type GitHubAppCredential,
  type GitHubAppRecord,
  type GitHubAppStore,
  receiptActorOf,
  type SecretAudit,
  type SecretKey,
  type SecretSlot,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { githubApps, receipts, workspaces } from "./schema.ts";
import {
  createPostgresSecretStore,
  deleteSecretInTx,
  describeSecret,
  secretAuditRefusal,
  writeSecretInTx,
} from "./secret-values.ts";

type Row = typeof githubApps.$inferSelect;

const keySlot = (row: Pick<Row, "id" | "workspaceId">): SecretSlot => ({
  workspaceId: row.workspaceId,
  owner: { kind: "github_app", id: row.id },
  purpose: "github_app_private_key",
});

function receiptRow(
  audit: SecretAudit,
  workspaceId: string,
  operation: "set_github_app" | "delete_github_app",
  appId: number,
  role: GitHubAppRole,
) {
  return {
    id: audit.receiptId,
    ownerId: workspaceId,
    actor: receiptActorOf(audit.principal),
    operation,
    targetRef: {
      resource: { kind: "workspace", id: workspaceId },
      workspace_id: workspaceId,
    },
    status: "succeeded" as const,
    result: { app_id: appId, role },
  };
}

const ofRole = (workspaceId: string, role: GitHubAppRole) =>
  and(eq(githubApps.workspaceId, workspaceId), eq(githubApps.role, role));

async function lockWorkspace(tx: Database, workspaceId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`github_apps:${workspaceId}`}))`,
  );
}

// A row is written with its key in one transaction, so a row without one is
// a delete that committed between the two reads.
async function recordOf(
  db: Database,
  row: Row,
): Promise<GitHubAppRecord | null> {
  const key = await describeSecret(db, keySlot(row));
  if (key === null) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    htmlUrl: row.htmlUrl,
    apiBase: row.apiBase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    privateKey: { updatedAt: key.updatedAt, updatedBy: key.updatedBy },
  };
}

export function createPostgresGitHubAppStore(
  db: Database,
  key: SecretKey,
): GitHubAppStore {
  const secrets = createPostgresSecretStore(db, key);
  return {
    async find(workspaceId, role) {
      const [row] = await db
        .select()
        .from(githubApps)
        .where(ofRole(workspaceId.toLowerCase(), role));
      return row ? recordOf(db, row) : null;
    },

    put(named, role, app, privateKey, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" };
        await lockWorkspace(tx, workspaceId);
        const fields = {
          appId: app.appId,
          slug: app.slug,
          name: app.name,
          htmlUrl: app.htmlUrl,
          apiBase: app.apiBase,
        };
        const [current] = await tx
          .select()
          .from(githubApps)
          .where(ofRole(workspaceId, role));
        const [row] = current
          ? await tx
              .update(githubApps)
              .set({ ...fields, updatedAt: DB_NOW })
              .where(eq(githubApps.id, current.id))
              .returning()
          : await tx
              .insert(githubApps)
              .values({
                id: randomUUID(),
                workspaceId,
                role,
                createdBy: audit.principal.actor?.userId ?? null,
                ...fields,
              })
              .returning();
        if (!row) throw new Error("GitHub App write returned no row");
        await writeSecretInTx(
          tx,
          key,
          keySlot(row),
          privateKey,
          audit.principal.actor?.userId ?? null,
        );
        await tx
          .insert(receipts)
          .values(
            receiptRow(audit, workspaceId, "set_github_app", app.appId, role),
          );
        const stored = await recordOf(tx, row);
        if (stored === null) throw new Error("GitHub App key was not written");
        return { outcome: "stored", app: stored };
      });
    },

    delete(named, role, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        await lockWorkspace(tx, workspaceId);
        const [row] = await tx
          .delete(githubApps)
          .where(ofRole(workspaceId, role))
          .returning();
        if (!row) return { outcome: "not_found" };
        await deleteSecretInTx(tx, keySlot(row));
        await tx
          .insert(receipts)
          .values(
            receiptRow(
              audit,
              workspaceId,
              "delete_github_app",
              row.appId,
              role,
            ),
          );
        return { outcome: "deleted", appId: row.appId };
      });
    },

    async credentials(role, workspaceId) {
      const rows = await db
        .select()
        .from(githubApps)
        .where(
          workspaceId === undefined
            ? eq(githubApps.role, role)
            : ofRole(workspaceId, role),
        );
      const held: GitHubAppCredential[] = [];
      for (const row of rows) {
        const privateKey = await secrets.get(keySlot(row));
        // A row is written with its key in one transaction, so a missing key
        // is a delete racing this read.
        if (privateKey === null) continue;
        held.push({
          id: row.id,
          workspaceId: row.workspaceId,
          appId: row.appId,
          apiBase: row.apiBase,
          privateKey,
          updatedAt: row.updatedAt,
        });
      }
      return held;
    },
  };
}
