import { randomUUID } from "node:crypto";
import {
  type GitHubAppPermissions,
  type GitHubAppRole,
  githubAppPermissionsSchema,
  githubAppWarnings,
} from "@werft-ai/contracts";
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
import {
  githubApps,
  githubWorkspaceSettings,
  receipts,
  workspaces,
} from "./schema.ts";
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

/** The author App's OAuth client secret, for linking people's accounts. */
export const oauthSecretSlot = (
  row: Pick<Row, "id" | "workspaceId">,
): SecretSlot => ({
  workspaceId: row.workspaceId,
  owner: { kind: "github_app", id: row.id },
  purpose: "github_oauth_client_secret",
});

// The secret belongs to the App it was made for: gone with the App, or once
// another App replaces it.
async function dropOAuthSecret(tx: Database, row: Row) {
  if (row.role !== "author") return;
  await deleteSecretInTx(tx, oauthSecretSlot(row));
  await tx
    .update(githubWorkspaceSettings)
    .set({ oauthClientSecretSet: false, updatedAt: DB_NOW })
    .where(eq(githubWorkspaceSettings.workspaceId, row.workspaceId));
}

function receiptRow(
  audit: SecretAudit,
  workspaceId: string,
  operation: "set_github_app" | "delete_github_app",
  appId: number,
  role: GitHubAppRole,
  permissions?: GitHubAppPermissions,
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
    result: {
      app_id: appId,
      role,
      ...(permissions === undefined
        ? {}
        : { permissions, warnings: githubAppWarnings(role, permissions) }),
    },
  };
}

const ofRole = (workspaceId: string, role: GitHubAppRole) =>
  and(eq(githubApps.workspaceId, workspaceId), eq(githubApps.role, role));

export async function lockGitHubApps(tx: Database, workspaceId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`github_apps:${workspaceId}`}))`,
  );
}

function permissionsOf(stored: unknown): GitHubAppPermissions | null {
  const parsed = githubAppPermissionsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
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
    permissions: permissionsOf(row.permissions),
    permissionsCheckedAt: row.permissionsCheckedAt,
    clientId: row.clientId,
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
        await lockGitHubApps(tx, workspaceId);
        const other = await tx
          .select({ appId: githubApps.appId })
          .from(githubApps)
          .where(
            ofRole(workspaceId, role === "author" ? "reviewer" : "author"),
          );
        if (role === "reviewer" && other.length === 0) {
          return { outcome: "no_author_app" };
        }
        if (other.some((held) => held.appId === app.appId)) {
          return { outcome: "same_app" };
        }
        const fields = {
          appId: app.appId,
          slug: app.slug,
          name: app.name,
          htmlUrl: app.htmlUrl,
          apiBase: app.apiBase,
          permissions: app.permissions,
          permissionsCheckedAt: DB_NOW,
          clientId: app.clientId,
        };
        const [current] = await tx
          .select()
          .from(githubApps)
          .where(ofRole(workspaceId, role));
        // A new key for the same App keeps its OAuth client secret.
        if (current && current.appId !== app.appId) {
          await dropOAuthSecret(tx, current);
        }
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
            receiptRow(
              audit,
              workspaceId,
              "set_github_app",
              app.appId,
              role,
              app.permissions,
            ),
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
        await lockGitHubApps(tx, workspaceId);
        const [row] = await tx
          .delete(githubApps)
          .where(ofRole(workspaceId, role))
          .returning();
        if (!row) return { outcome: "not_found" };
        await deleteSecretInTx(tx, keySlot(row));
        await dropOAuthSecret(tx, row);
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

    async recordPermissions(id, appId, permissions, clientId) {
      await db
        .update(githubApps)
        .set({
          permissions,
          permissionsCheckedAt: DB_NOW,
          ...(clientId === undefined ? {} : { clientId }),
        })
        .where(and(eq(githubApps.id, id), eq(githubApps.appId, appId)));
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
