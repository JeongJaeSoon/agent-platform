import { GITHUB_CEILING_NONE } from "@werft-ai/contracts";
import {
  type GitHubOAuthClient,
  type GitHubOAuthStore,
  receiptActorOf,
  type SecretKey,
} from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import { DB_NOW } from "./db-clock.ts";
import { lockGitHubApps, oauthSecretSlot } from "./github-apps.ts";
import type { Database } from "./queries.ts";
import {
  githubApps,
  githubWorkspaceSettings,
  receipts,
  workspaces,
} from "./schema.ts";
import {
  createPostgresSecretStore,
  secretAuditRefusal,
  writeSecretInTx,
} from "./secret-values.ts";

const author = (workspaceId: string) =>
  and(eq(githubApps.workspaceId, workspaceId), eq(githubApps.role, "author"));

/** `https://github.com/apps/<slug>` → `https://github.com`. */
function webBaseOf(htmlUrl: string): string | null {
  try {
    return new URL(htmlUrl).origin;
  } catch {
    return null;
  }
}

/** Null `key`: the API runs without a master key, so no secret is kept. */
export function createPostgresGitHubOAuthStore(
  db: Database,
  key: SecretKey | null,
): GitHubOAuthStore {
  const secrets = key === null ? null : createPostgresSecretStore(db, key);
  return {
    async status(named) {
      const workspaceId = named.toLowerCase();
      const [row] = await db
        .select({
          clientId: githubApps.clientId,
          secretSet: githubWorkspaceSettings.oauthClientSecretSet,
        })
        .from(githubApps)
        .leftJoin(
          githubWorkspaceSettings,
          eq(githubWorkspaceSettings.workspaceId, githubApps.workspaceId),
        )
        .where(author(workspaceId))
        .limit(1);
      return {
        authorApp: row !== undefined,
        clientId: row?.clientId ?? null,
        clientSecretSet: row?.secretSet ?? false,
      };
    },

    async client(named): Promise<GitHubOAuthClient | null> {
      if (secrets === null) return null;
      const workspaceId = named.toLowerCase();
      const [row] = await db
        .select()
        .from(githubApps)
        .where(author(workspaceId))
        .limit(1);
      if (row === undefined || row.clientId === null) return null;
      const webBase = webBaseOf(row.htmlUrl);
      if (webBase === null) return null;
      const clientSecret = await secrets.get(oauthSecretSlot(row));
      if (clientSecret === null) return null;
      return {
        clientId: row.clientId,
        clientSecret,
        webBase,
        apiBase: row.apiBase,
      };
    },

    putClientSecret(named, clientSecret, audit, clientId) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        if (key === null) return { outcome: "no_author_app" as const };
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" as const };
        // Serialized with the App's replacement and deletion, which drop it.
        await lockGitHubApps(tx, workspaceId);
        const [row] = await tx
          .select()
          .from(githubApps)
          .where(author(workspaceId))
          .limit(1);
        if (row === undefined) return { outcome: "no_author_app" as const };
        if (row.clientId !== clientId) {
          return { outcome: "client_changed" as const };
        }
        const updatedBy = audit.principal.actor?.userId ?? null;
        await writeSecretInTx(
          tx,
          key,
          oauthSecretSlot(row),
          clientSecret,
          updatedBy,
        );
        // `revision` is the ceiling's compare-and-set, which this leaves be:
        // a row made here reads as the never-saved ceiling, revision 0.
        await tx
          .insert(githubWorkspaceSettings)
          .values({
            workspaceId,
            ceiling: GITHUB_CEILING_NONE,
            oauthClientSecretSet: true,
            revision: 0,
            updatedBy,
          })
          .onConflictDoUpdate({
            target: githubWorkspaceSettings.workspaceId,
            set: { oauthClientSecretSet: true, updatedAt: DB_NOW },
          });
        await tx.insert(receipts).values({
          id: audit.receiptId,
          ownerId: workspaceId,
          actor: receiptActorOf(audit.principal),
          operation: "set_github_app",
          targetRef: {
            resource: { kind: "workspace", id: workspaceId },
            workspace_id: workspaceId,
          },
          status: "succeeded",
          result: {
            app_id: row.appId,
            role: "author",
            purpose: "oauth_client_secret",
            last4: clientSecret.slice(-4),
          },
        });
        return { outcome: "stored" as const };
      });
    },
  };
}
