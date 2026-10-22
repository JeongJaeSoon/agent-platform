import type {
  AgentAdminChangeResult,
  AgentAdminStore,
  AgentAdmins,
  TeamActor,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  exists,
  isNull,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { agentOf } from "./agents.ts";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  users,
} from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True where `userId` administers `agentId` in `workspaceId`: an admin row of
 * their own, or a live team they are a live member of. Team membership is
 * read here, at the decision, never cached (design 4.7). Whether the person
 * is still a live member of the workspace is the caller's to join.
 */
export function administers(
  db: Database,
  workspaceId: string,
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

/**
 * `administers`, inside a write: the rows that make it true are share-locked
 * so removing them waits for this transaction, or is seen by it.
 */
export async function lockedAdministers(
  tx: Database,
  workspaceId: string,
  agentId: string,
  userId: string,
): Promise<boolean> {
  const direct = await tx
    .select({ agentId: agentAdmins.agentId })
    .from(agentAdmins)
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        eq(agentAdmins.agentId, agentId),
        eq(agentAdmins.userId, userId),
      ),
    )
    .limit(1)
    .for("share");
  if (direct.length > 0) return true;
  const viaTeam = () =>
    tx
      .select({ teamId: agentAdminTeams.teamId })
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
  // Team rows first, in a statement of their own: a team's writers lock it
  // before its other rows, and one statement locks its rows in no set order
  // whatever FOR SHARE OF lists.
  const teams = await viaTeam().for("share", { of: memberTeams });
  if (teams.length === 0) return false;
  const held = await viaTeam()
    .limit(1)
    .for("share", { of: [memberTeams, agentAdminTeams, memberTeamMembers] });
  return held.length > 0;
}

async function listAdmins(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<AgentAdmins> {
  const people = await db
    .select({
      userId: agentAdmins.userId,
      email: users.email,
      displayName: users.displayName,
      createdBy: agentAdmins.createdBy,
      createdAt: agentAdmins.createdAt,
    })
    .from(agentAdmins)
    .innerJoin(users, eq(users.id, agentAdmins.userId))
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        eq(agentAdmins.agentId, agentId),
      ),
    )
    .orderBy(asc(agentAdmins.createdAt), asc(agentAdmins.userId));
  const teams = await db
    .select({
      teamId: agentAdminTeams.teamId,
      name: memberTeams.name,
      createdBy: agentAdminTeams.createdBy,
      createdAt: agentAdminTeams.createdAt,
    })
    .from(agentAdminTeams)
    .innerJoin(memberTeams, eq(memberTeams.id, agentAdminTeams.teamId))
    .where(
      and(
        eq(agentAdminTeams.workspaceId, workspaceId),
        eq(agentAdminTeams.agentId, agentId),
      ),
    )
    .orderBy(asc(agentAdminTeams.createdAt), asc(agentAdminTeams.teamId));
  return { users: people, teams };
}

// The acting person may change this agent's admins: a live member whose role
// holds the right, or who administers the agent themselves. `people` are
// locked first by lockPeople; the agent row, locked before the admin rows,
// queues changes to one agent's admins so two admins removing each other
// cannot each hold the row the other deletes.
async function actorMayManage(
  tx: Database,
  actor: TeamActor,
  people: Awaited<ReturnType<typeof lockPeople>>,
  agentId: string,
  managerRoles: readonly string[],
): Promise<"yes" | "no" | "no_agent"> {
  const me = people.find((p) => p.userId === actor.userId);
  if (!me?.live) return "no";
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.workspaceId, actor.workspaceId), eq(agents.id, agentId)),
    )
    .for("no key update");
  if (!agent) return managerRoles.includes(me.role) ? "no_agent" : "no";
  if (managerRoles.includes(me.role)) return "yes";
  return (await lockedAdministers(tx, actor.workspaceId, agentId, actor.userId))
    ? "yes"
    : "no";
}

async function change(
  db: Database,
  input: Parameters<AgentAdminStore["add"]>[0],
  add: boolean,
): Promise<AgentAdminChangeResult> {
  const { actor, subject } = input;
  if (!UUID.test(input.agentId)) return { outcome: "not_found" };
  if (!UUID.test(subject.id)) return { outcome: "subject_not_found" };
  const agentId = input.agentId.toLowerCase();
  const subjectId = subject.id.toLowerCase();
  const workspaceId = actor.workspaceId;
  return db.transaction(async (tx) => {
    const people = await lockPeople(
      tx,
      workspaceId,
      subject.kind === "user" ? [actor.userId, subjectId] : [actor.userId],
    );
    const may = await actorMayManage(
      tx,
      actor,
      people,
      agentId,
      input.managerRoles,
    );
    if (may === "no") return { outcome: "actor_inactive" };
    if (may === "no_agent") return { outcome: "not_found" };

    let changed: boolean;
    if (subject.kind === "user") {
      if (add) {
        const live = people.some((p) => p.userId === subjectId && p.live);
        if (!live) return { outcome: "subject_not_found" };
        const inserted = await tx
          .insert(agentAdmins)
          .values({
            workspaceId,
            agentId,
            userId: subjectId,
            createdBy: actor.userId,
          })
          .onConflictDoNothing()
          .returning({ userId: agentAdmins.userId });
        changed = inserted.length > 0;
      } else {
        const deleted = await tx
          .delete(agentAdmins)
          .where(
            and(
              eq(agentAdmins.workspaceId, workspaceId),
              eq(agentAdmins.agentId, agentId),
              eq(agentAdmins.userId, subjectId),
            ),
          )
          .returning({ userId: agentAdmins.userId });
        changed = deleted.length > 0;
      }
    } else if (add) {
      const [team] = await tx
        .select({ id: memberTeams.id })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, workspaceId),
            eq(memberTeams.id, subjectId),
            isNull(memberTeams.archivedAt),
          ),
        )
        .for("share");
      if (!team) return { outcome: "subject_not_found" };
      const inserted = await tx
        .insert(agentAdminTeams)
        .values({
          workspaceId,
          agentId,
          teamId: subjectId,
          createdBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning({ teamId: agentAdminTeams.teamId });
      changed = inserted.length > 0;
    } else {
      const deleted = await tx
        .delete(agentAdminTeams)
        .where(
          and(
            eq(agentAdminTeams.workspaceId, workspaceId),
            eq(agentAdminTeams.agentId, agentId),
            eq(agentAdminTeams.teamId, subjectId),
          ),
        )
        .returning({ teamId: agentAdminTeams.teamId });
      changed = deleted.length > 0;
    }

    if (changed) {
      await tx.insert(receipts).values({
        id: input.receiptId,
        ownerId: actor.principal.ownerId,
        actor: receiptActorOf(actor.principal),
        operation: add ? "add_agent_admin" : "remove_agent_admin",
        targetRef: {
          resource: { kind: "agent", id: agentId },
          workspace_id: workspaceId,
        },
        result: { subject: { kind: subject.kind, id: subjectId } },
        status: "succeeded",
        requestId: actor.principal.requestId ?? null,
      });
    }
    return {
      outcome: changed ? (add ? "added" : "removed") : "unchanged",
      admins: await listAdmins(tx, workspaceId, agentId),
    };
  });
}

export function createPostgresAgentAdminStore(db: Database): AgentAdminStore {
  return {
    async list(workspaceId, agentId) {
      if (!UUID.test(workspaceId) || !UUID.test(agentId)) return null;
      const id = agentId.toLowerCase();
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
      if (!agent) return null;
      return listAdmins(db, workspaceId, id);
    },
    add: (input) => change(db, input, true),
    remove: (input) => change(db, input, false),
    async listAdministered(workspaceId, userId, limit) {
      if (!UUID.test(workspaceId) || !UUID.test(userId)) return [];
      const rows = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            administers(db, workspaceId, userId.toLowerCase(), agents.id),
            // A disabled member administers nothing.
            exists(
              db
                .select({ one: sql`1` })
                .from(memberships)
                .innerJoin(users, eq(users.id, memberships.userId))
                .where(
                  and(
                    eq(memberships.workspaceId, workspaceId),
                    eq(memberships.userId, userId.toLowerCase()),
                    isNull(memberships.disabledAt),
                    isNull(users.disabledAt),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(limit);
      return rows.map(agentOf);
    },
  };
}
