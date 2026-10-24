import {
  and,
  eq,
  exists,
  isNull,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  memberships,
  memberTeamMembers,
  memberTeams,
  users,
} from "./schema.ts";

/**
 * True where `userId` administers `agentId` in `workspaceId`: an admin row of
 * their own, or a live team they are a live member of. Team membership is
 * read here, at the decision, never cached (design 4.7). Whether the person
 * is still a live member of the workspace is the caller's to join.
 */
export function administers(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string | SQLWrapper,
  agentId: string | SQLWrapper,
): SQL {
  const direct = db
    .select({ one: sql`1` })
    .from(agentAdmins)
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        eq(agentAdmins.agentId, agentId),
        eq(agentAdmins.userId, userId),
      ),
    );
  const viaTeam = db
    .select({ one: sql`1` })
    .from(agentAdminTeams)
    .innerJoin(
      memberTeams,
      and(
        eq(memberTeams.id, agentAdminTeams.teamId),
        isNull(memberTeams.archivedAt),
      ),
    )
    .innerJoin(
      memberTeamMembers,
      and(
        eq(memberTeamMembers.teamId, agentAdminTeams.teamId),
        isNull(memberTeamMembers.removedAt),
      ),
    )
    .where(
      and(
        eq(agentAdminTeams.workspaceId, workspaceId),
        eq(agentAdminTeams.agentId, agentId),
        eq(memberTeamMembers.userId, userId),
      ),
    );
  return or(exists(direct), exists(viaTeam)) as SQL;
}

/** True while `userId` is an enabled member of `workspaceId`: a disabled member administers nothing. */
export function liveMember(
  db: Database,
  workspaceId: string,
  userId: string,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userId),
          isNull(memberships.disabledAt),
          isNull(users.disabledAt),
        ),
      ),
  );
}
