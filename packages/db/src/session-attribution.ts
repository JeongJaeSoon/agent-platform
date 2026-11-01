import type { SessionTrigger } from "@werft-ai/contracts";
import type { SessionAttributionStore } from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  apiKeys,
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
      return {
        ownerId: row.ownerId,
        trigger: triggerOf(row),
        agentId: row.agentId,
        agentReleaseId: row.agentReleaseId,
        starter:
          row.startedBy === null ? null : { userId: row.startedBy, github },
      };
    },
  };
}
