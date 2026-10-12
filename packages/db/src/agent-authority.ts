import type { AgentAuthority } from "@agent-platform/platform";
import { and, eq, isNull } from "drizzle-orm";
import { administers } from "./agent-admins.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  memberships,
  sessions,
  users,
} from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDatabaseAgentAuthority(db: Database): AgentAuthority {
  return {
    async agentOf(workspaceId, resource) {
      // A malformed id would reach a uuid column as a 22P02.
      if (!UUID.test(resource.id) || !UUID.test(workspaceId)) return null;
      const id = resource.id.toLowerCase();
      if (resource.kind === "agent") {
        const [row] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
          .limit(1);
        return row?.id ?? null;
      }
      if (resource.kind === "session") {
        // A session belongs to the agent of the release it was pinned to; one
        // made from a profile alone belongs to none.
        const [row] = await db
          .select({ agentId: agentReleases.agentId })
          .from(sessions)
          .innerJoin(
            agentReleases,
            eq(agentReleases.id, sessions.agentReleaseId),
          )
          .innerJoin(
            agents,
            and(
              eq(agents.id, agentReleases.agentId),
              eq(agents.workspaceId, workspaceId),
            ),
          )
          .where(and(eq(sessions.id, id), eq(sessions.ownerId, workspaceId)))
          .limit(1);
        return row?.agentId ?? null;
      }
      return null;
    },

    async isAdmin(workspaceId, agentId, userId) {
      if (![workspaceId, agentId, userId].every((v) => UUID.test(v))) {
        return false;
      }
      const [row] = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(
          users,
          and(eq(users.id, memberships.userId), isNull(users.disabledAt)),
        )
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, userId.toLowerCase()),
            isNull(memberships.disabledAt),
            administers(
              db,
              workspaceId,
              userId.toLowerCase(),
              agentId.toLowerCase(),
            ),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
