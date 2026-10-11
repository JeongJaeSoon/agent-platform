import type {
  Team,
  TeamActor,
  TeamMember,
  TeamMembershipResult,
  TeamStore,
} from "@agent-platform/platform";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import {
  agentAdminTeams,
  memberTeamMembers,
  memberTeams,
  receipts,
  users,
} from "./schema.ts";

// Teams (94S-582, design 4.7). Lock order, everywhere here: the people
// involved (users, then memberships, in user_id order), the team, then team
// member rows — the order the rest of the identity writes take.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// D23: changing a team is the workspace's managers' alone.
const TEAM_MANAGERS = ["owner", "admin"];

type TeamOperation =
  | "create_team"
  | "rename_team"
  | "delete_team"
  | "add_team_member"
  | "remove_team_member";

async function actorManagesTeams(
  tx: Database,
  actor: TeamActor,
  others: readonly string[] = [],
) {
  const people = await lockPeople(tx, actor.workspaceId, [
    actor.userId,
    ...others,
  ]);
  const me = people.find((p) => p.userId === actor.userId);
  return me?.live === true && TEAM_MANAGERS.includes(me.role) ? people : null;
}

async function lockLiveTeam(tx: Database, workspaceId: string, teamId: string) {
  if (!UUID.test(teamId)) return null;
  const [row] = await tx
    .select()
    .from(memberTeams)
    .where(
      and(
        eq(memberTeams.workspaceId, workspaceId),
        eq(memberTeams.id, teamId.toLowerCase()),
        isNull(memberTeams.archivedAt),
      ),
    )
    .for("update");
  return row ?? null;
}

async function teamOf(
  db: Database,
  row: typeof memberTeams.$inferSelect,
): Promise<Team> {
  const [counted] = await db
    .select({ n: count() })
    .from(memberTeamMembers)
    .where(
      and(
        eq(memberTeamMembers.teamId, row.id),
        isNull(memberTeamMembers.removedAt),
      ),
    );
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revision: row.revision,
    memberCount: counted?.n ?? 0,
  };
}

async function writeReceipt(
  tx: Database,
  actor: TeamActor,
  input: {
    id: string;
    operation: TeamOperation;
    targetRef: unknown;
    result: unknown;
  },
) {
  await tx.insert(receipts).values({
    id: input.id,
    ownerId: actor.principal.ownerId,
    actor: receiptActorOf(actor.principal),
    operation: input.operation,
    targetRef: input.targetRef,
    result: input.result,
    status: "succeeded",
  });
}

function teamTarget(teamId: string, workspaceId: string) {
  return { resource: { kind: "team", id: teamId }, workspace_id: workspaceId };
}

// Two renames racing to one free name: the live-name index refuses the
// second. drizzle wraps the driver's error, so the code may sit on its cause;
// any other unique violation (a reused receipt id) is not a name clash.
function isLiveNameTaken(error: unknown): boolean {
  for (let e = error; typeof e === "object" && e !== null; ) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (code === "23505") return constraint === "member_teams_live_name_uniq";
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function bumpRevision(tx: Database, teamId: string) {
  await tx
    .update(memberTeams)
    .set({ revision: sql`${memberTeams.revision} + 1` })
    .where(eq(memberTeams.id, teamId));
}

export function createPostgresTeamStore(db: Database): TeamStore {
  return {
    async create(input) {
      const { actor } = input;
      try {
        return await db.transaction(async (tx) => {
          if (!(await actorManagesTeams(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const [row] = await tx
            .insert(memberTeams)
            .values({
              id: input.teamId,
              workspaceId: actor.workspaceId,
              name: input.name,
              createdBy: actor.userId,
            })
            .onConflictDoNothing()
            .returning();
          if (!row) return { outcome: "name_taken" as const };
          await writeReceipt(tx, actor, {
            id: input.receiptId,
            operation: "create_team",
            targetRef: teamTarget(row.id, actor.workspaceId),
            result: { name: row.name },
          });
          return { outcome: "created" as const, team: await teamOf(tx, row) };
        });
      } catch (error) {
        if (isLiveNameTaken(error)) return { outcome: "name_taken" };
        throw error;
      }
    },

    async rename(input) {
      const { actor } = input;
      try {
        return await db.transaction(async (tx) => {
          if (!(await actorManagesTeams(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const team = await lockLiveTeam(tx, actor.workspaceId, input.teamId);
          if (!team) return { outcome: "not_found" as const };
          if (team.name === input.name) {
            return {
              outcome: "unchanged" as const,
              team: await teamOf(tx, team),
            };
          }
          const [taken] = await tx
            .select({ id: memberTeams.id })
            .from(memberTeams)
            .where(
              and(
                eq(memberTeams.workspaceId, actor.workspaceId),
                eq(memberTeams.name, input.name),
                isNull(memberTeams.archivedAt),
              ),
            );
          if (taken) return { outcome: "name_taken" as const };
          const [row] = await tx
            .update(memberTeams)
            .set({
              name: input.name,
              revision: sql`${memberTeams.revision} + 1`,
            })
            .where(eq(memberTeams.id, team.id))
            .returning();
          if (!row) throw new Error(`team ${team.id} vanished under its lock`);
          await writeReceipt(tx, actor, {
            id: input.receiptId,
            operation: "rename_team",
            targetRef: teamTarget(team.id, actor.workspaceId),
            result: { from: team.name, to: row.name },
          });
          return { outcome: "renamed" as const, team: await teamOf(tx, row) };
        });
      } catch (error) {
        if (isLiveNameTaken(error)) return { outcome: "name_taken" };
        throw error;
      }
    },

    delete(input) {
      const { actor } = input;
      return db.transaction(async (tx) => {
        if (!(await actorManagesTeams(tx, actor))) {
          return { outcome: "actor_inactive" };
        }
        const team = await lockLiveTeam(tx, actor.workspaceId, input.teamId);
        if (!team) return { outcome: "not_found" };
        // The authority a team lent ends with it; the member rows stay as
        // history behind an archived team that no decision reads.
        const dropped = await tx
          .delete(agentAdminTeams)
          .where(eq(agentAdminTeams.teamId, team.id))
          .returning({ agentId: agentAdminTeams.agentId });
        await tx
          .update(memberTeams)
          .set({
            archivedAt: sql`now()`,
            revision: sql`${memberTeams.revision} + 1`,
          })
          .where(eq(memberTeams.id, team.id));
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: "delete_team",
          targetRef: teamTarget(team.id, actor.workspaceId),
          result: {
            name: team.name,
            agent_ids: dropped.map((row) => row.agentId),
          },
        });
        return { outcome: "deleted" };
      });
    },

    addMember(input) {
      return changeMember(db, input, true);
    },

    removeMember(input) {
      return changeMember(db, input, false);
    },

    async list(workspaceId, limit) {
      if (!UUID.test(workspaceId)) return [];
      const rows = await db
        .select({
          team: memberTeams,
          memberCount: sql<number>`(
            SELECT count(*)::int FROM ${memberTeamMembers}
            WHERE ${memberTeamMembers.teamId} = ${memberTeams.id}
              AND ${memberTeamMembers.removedAt} IS NULL
          )`,
        })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, workspaceId),
            isNull(memberTeams.archivedAt),
          ),
        )
        .orderBy(asc(memberTeams.name), asc(memberTeams.id))
        .limit(limit);
      return rows.map(({ team, memberCount }) => ({
        id: team.id,
        workspaceId: team.workspaceId,
        name: team.name,
        createdBy: team.createdBy,
        createdAt: team.createdAt,
        revision: team.revision,
        memberCount,
      }));
    },

    async get(workspaceId, teamId) {
      if (!UUID.test(workspaceId) || !UUID.test(teamId)) return null;
      const [row] = await db
        .select()
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, workspaceId),
            eq(memberTeams.id, teamId.toLowerCase()),
            isNull(memberTeams.archivedAt),
          ),
        );
      if (!row) return null;
      const members: TeamMember[] = await db
        .select({
          userId: memberTeamMembers.userId,
          email: users.email,
          displayName: users.displayName,
          addedBy: memberTeamMembers.addedBy,
          addedAt: memberTeamMembers.addedAt,
        })
        .from(memberTeamMembers)
        .innerJoin(users, eq(users.id, memberTeamMembers.userId))
        .where(
          and(
            eq(memberTeamMembers.teamId, row.id),
            isNull(memberTeamMembers.removedAt),
          ),
        )
        .orderBy(asc(memberTeamMembers.addedAt), asc(memberTeamMembers.userId));
      return { ...(await teamOf(db, row)), members };
    },
  };
}

async function changeMember(
  db: Database,
  input: Parameters<TeamStore["addMember"]>[0],
  add: boolean,
): Promise<TeamMembershipResult> {
  const { actor } = input;
  if (!UUID.test(input.userId)) {
    return { outcome: add ? "not_member" : "not_found" };
  }
  const userId = input.userId.toLowerCase();
  return db.transaction(async (tx) => {
    const people = await actorManagesTeams(tx, actor, [userId]);
    if (!people) return { outcome: "actor_inactive" };
    const team = await lockLiveTeam(tx, actor.workspaceId, input.teamId);
    if (!team) return { outcome: "not_found" };
    const [current] = await tx
      .select({ id: memberTeamMembers.id })
      .from(memberTeamMembers)
      .where(
        and(
          eq(memberTeamMembers.teamId, team.id),
          eq(memberTeamMembers.userId, userId),
          isNull(memberTeamMembers.removedAt),
        ),
      )
      .for("update");
    if (add) {
      if (current) {
        return { outcome: "unchanged", team: await teamOf(tx, team) };
      }
      // A disabled member stays out: they would hold nothing through the
      // team, and adding them would read as if they did.
      if (!people.some((p) => p.userId === userId && p.live)) {
        return { outcome: "not_member" };
      }
      await tx.insert(memberTeamMembers).values({
        id: crypto.randomUUID(),
        workspaceId: actor.workspaceId,
        teamId: team.id,
        userId,
        addedBy: actor.userId,
      });
    } else {
      if (!current) {
        return { outcome: "unchanged", team: await teamOf(tx, team) };
      }
      await tx
        .update(memberTeamMembers)
        .set({ removedAt: sql`now()` })
        .where(eq(memberTeamMembers.id, current.id));
    }
    await bumpRevision(tx, team.id);
    // Written on the person, not the team: their receipt list is where they
    // learn which team they were put in or taken out of.
    await writeReceipt(tx, actor, {
      id: input.receiptId,
      operation: add ? "add_team_member" : "remove_team_member",
      targetRef: { user_id: userId, workspace_id: actor.workspaceId },
      result: { team_id: team.id, team_name: team.name },
    });
    const [after] = await tx
      .select()
      .from(memberTeams)
      .where(eq(memberTeams.id, team.id));
    if (!after) throw new Error(`team ${team.id} vanished under its lock`);
    return {
      outcome: add ? "added" : "removed",
      team: await teamOf(tx, after),
    };
  });
}
