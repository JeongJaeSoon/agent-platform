import type { SessionTrigger } from "@werft-ai/contracts";
import type { SessionAttributionStore } from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  apiKeys,
  catalogRepositoryGitHubApps,
  githubApps,
  linkedAccounts,
  sessions,
  turns,
} from "./schema.ts";

function triggerOf(row: {
  channel: string | null;
  keyKind: string | null;
  createdByApiKeyId: string | null;
  createdByUserId: string | null;
}): SessionTrigger {
  if (row.channel === "web" || row.channel === "slack") return row.channel;
  const byKey =
    row.keyKind === "personal"
      ? "personal_key"
      : row.keyKind === "agent"
        ? "agent_key"
        : "operator_key";
  if (row.channel === "api") return byKey;
  // Rows from before `channel`: their creator columns are all there is.
  if (row.createdByApiKeyId !== null) return byKey;
  return row.createdByUserId !== null ? "web" : "operator_key";
}

export function createPostgresSessionAttributionStore(
  db: Database,
): SessionAttributionStore {
  return {
    async attribution(rawSessionId) {
      const sessionId = rawSessionId.toLowerCase();
      const [row] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: sessions.workspaceId,
          repositoryId: sessions.repositoryId,
          channel: sessions.channel,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
          keyKind: apiKeys.kind,
          // Turn 1's actor, else the creator: the session-shares rule.
          startedBy: sql<
            string | null
          >`coalesce((SELECT t.actor_id FROM ${turns} t WHERE t.session_id = ${sessions.id} AND t.sequence = 1), ${sessions.createdByUserId})`,
          agentId: agentReleases.agentId,
          agentReleaseId: sessions.agentReleaseId,
        })
        .from(sessions)
        .leftJoin(apiKeys, eq(apiKeys.id, sessions.createdByApiKeyId))
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (row === undefined) return null;
      let github: { id: string; login: string } | null = null;
      if (row.startedBy !== null && row.workspaceId !== null) {
        const [link] = await db
          .select({
            id: linkedAccounts.externalUserId,
            login: linkedAccounts.externalUserName,
          })
          .from(linkedAccounts)
          .where(
            and(
              eq(linkedAccounts.workspaceId, row.workspaceId),
              eq(linkedAccounts.userId, row.startedBy),
              eq(linkedAccounts.provider, "github"),
              eq(linkedAccounts.status, "active"),
            ),
          )
          .limit(1);
        github =
          link === undefined || link.login === null
            ? null
            : { id: link.id, login: link.login };
      }
      // The App the primary repository is pinned to, the one that opens its
      // pull requests (decision D11). A pin whose connection is gone or now
      // holds another App names none: no other App stands in for it.
      let authorApp: { slug: string; apiBase: string } | null = null;
      let authorPinned = false;
      if (row.workspaceId !== null && row.repositoryId !== null) {
        const [pin] = await db
          .select({
            slug: githubApps.slug,
            apiBase: githubApps.apiBase,
          })
          .from(catalogRepositoryGitHubApps)
          .leftJoin(
            githubApps,
            and(
              eq(githubApps.id, catalogRepositoryGitHubApps.connectionId),
              eq(githubApps.appId, catalogRepositoryGitHubApps.appId),
              eq(githubApps.role, "author"),
              eq(githubApps.workspaceId, row.workspaceId),
            ),
          )
          .where(
            and(
              eq(catalogRepositoryGitHubApps.repositoryId, row.repositoryId),
              eq(catalogRepositoryGitHubApps.role, "author"),
            ),
          )
          .limit(1);
        if (pin !== undefined) {
          authorPinned = true;
          authorApp =
            pin.slug === null || pin.apiBase === null
              ? null
              : { slug: pin.slug, apiBase: pin.apiBase };
        }
      }
      return {
        ownerId: row.ownerId,
        authorApp,
        authorPinned,
        trigger: triggerOf(row),
        agentId: row.agentId,
        agentReleaseId: row.agentReleaseId,
        starter:
          row.startedBy === null ? null : { userId: row.startedBy, github },
      };
    },
  };
}
