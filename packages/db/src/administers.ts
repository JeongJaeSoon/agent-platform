import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  memberships,
  memberTeamMembers,
  memberTeams,
  users,
} from "./schema.ts";

// Aliased: callers pass an outer `agents.id` as `agentId`.
const managed = alias(agents, "managed_agent");

// The agent's managing team, live, and the person's live row in it.
function inManagingTeam(
  db: Database,
  workspaceId: string | SQLWrapper,
  userId: string | SQLWrapper,
  agentId: string | SQLWrapper,
  lead: boolean,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(managed)
      .innerJoin(
        memberTeams,
        and(
          eq(memberTeams.id, managed.managingTeamId),
          isNull(memberTeams.archivedAt),
        ),
      )
      .innerJoin(
        memberTeamMembers,
        and(
          eq(memberTeamMembers.teamId, managed.managingTeamId),
          isNull(memberTeamMembers.removedAt),
          lead ? eq(memberTeamMembers.role, "lead") : undefined,
        ),
      )
      .where(
        and(
          eq(managed.workspaceId, workspaceId),
          eq(managed.id, agentId),
          eq(memberTeamMembers.userId, userId),
        ),
      ),
  );
}

/**
 * True where `userId` administers `agentId` in `workspaceId`: an admin row of
 * their own, a live admin team they are a live member of, or the lead of the
 * agent's live managing team. Team membership is read here, at the decision,
 * never cached (design 4.7). Whether the person is still a live member of the
 * workspace is the caller's to join.
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
  return or(
    exists(direct),
    exists(viaTeam),
    inManagingTeam(db, workspaceId, userId, agentId, true),
  ) as SQL;
}

const WORKSPACE_MANAGERS = ["owner", "admin"];
const managerRow = alias(memberships, "manager_membership");

/**
 * True where `userId`, a live member of `workspaceId`, is inside `agentId`:
 * an owner or admin, one of its admins (`administers`), or a live member of
 * its live managing team (agent-rbac design (b)).
 */
export function insideAgent(
  db: Database,
  workspaceId: string,
  userId: string,
  agentId: string | SQLWrapper,
): SQL {
  const manager = exists(
    db
      .select({ one: sql`1` })
      .from(managerRow)
      .where(
        and(
          eq(managerRow.workspaceId, workspaceId),
          eq(managerRow.userId, userId),
          inArray(managerRow.role, WORKSPACE_MANAGERS),
        ),
      ),
  );
  return and(
    liveMember(db, workspaceId, userId),
    or(
      manager,
      administers(db, workspaceId, userId, agentId),
      inManagingTeam(db, workspaceId, userId, agentId, false),
    ),
  ) as SQL;
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
