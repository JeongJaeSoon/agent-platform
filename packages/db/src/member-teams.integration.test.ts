import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { type Caller, callerFor, type TeamActor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresTeamStore } from "./member-teams.ts";
import * as schema from "./schema.ts";
import {
  memberships,
  memberTeamMembers,
  receipts,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("teams and teams as agent admins on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "member_teams_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";

  function acting(caller: Caller): TeamActor {
    return {
      principal: caller,
      workspaceId: caller.ownerId,
      userId: idOf(caller),
    };
  }

  const teams = () => createPostgresTeamStore(db);

  async function newTeam(by: Caller, name = `team-${randomUUID()}`) {
    const result = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name,
    });
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.team;
  }

  const member = (by: Caller, teamId: string, who: Caller, add = true) =>
    teams()[add ? "addMember" : "removeMember"]({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(who),
    });

  test("owners and admins create, rename and delete teams; names are unique while live", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const plain = await person(workspaceId, "member");

    const team = await newTeam(owner, "research");
    expect(team).toMatchObject({ name: "research", memberCount: 0 });
    expect(
      await teams().create({
        actor: acting(admin),
        receiptId: randomUUID(),
        teamId: randomUUID(),
        name: "research",
      }),
    ).toEqual({ outcome: "name_taken" });
    expect(
      await teams().create({
        actor: acting(plain),
        receiptId: randomUUID(),
        teamId: randomUUID(),
        name: "mine",
      }),
    ).toEqual({ outcome: "actor_inactive" });

    const other = await newTeam(admin, "ops");
    expect(
      await teams().rename({
        actor: acting(admin),
        receiptId: randomUUID(),
        teamId: other.id,
        name: "research",
      }),
    ).toEqual({ outcome: "name_taken" });
    const renamed = await teams().rename({
      actor: acting(admin),
      receiptId: randomUUID(),
      teamId: other.id,
      name: "operations",
    });
    expect(renamed).toMatchObject({
      outcome: "renamed",
      team: { name: "operations", revision: 2 },
    });
    expect(
      await teams().rename({
        actor: acting(plain),
        receiptId: randomUUID(),
        teamId: other.id,
        name: "x",
      }),
    ).toEqual({ outcome: "actor_inactive" });

    expect(
      await teams().delete({
        actor: acting(plain),
        receiptId: randomUUID(),
        teamId: team.id,
      }),
    ).toEqual({ outcome: "actor_inactive" });
    expect(
      await teams().delete({
        actor: acting(owner),
        receiptId: randomUUID(),
        teamId: team.id,
      }),
    ).toEqual({ outcome: "deleted" });
    expect(await teams().get(workspaceId, team.id)).toBeNull();
    expect(
      await teams().delete({
        actor: acting(owner),
        receiptId: randomUUID(),
        teamId: team.id,
      }),
    ).toEqual({ outcome: "not_found" });
    // A deleted team's name is free again.
    await newTeam(owner, "research");
    expect((await teams().list(workspaceId, 50)).map((t) => t.name)).toEqual([
      "operations",
      "research",
    ]);

    // Another workspace's team does not exist here.
    const elsewhere = await workspace();
    const stranger = await person(elsewhere, "owner");
    expect(
      await teams().rename({
        actor: acting(stranger),
        receiptId: randomUUID(),
        teamId: other.id,
        name: "taken over",
      }),
    ).toEqual({ outcome: "not_found" });
  });

  test("members join at once, leave at once, and the receipt names the person", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const joiner = await person(workspaceId, "member");
    const disabled = await person(workspaceId, "member");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(disabled)));
    const outsider = await person(await workspace(), "member");
    const team = await newTeam(owner);

    const added = await member(owner, team.id, joiner);
    expect(added).toMatchObject({ outcome: "added", team: { memberCount: 1 } });
    expect(await member(owner, team.id, joiner)).toMatchObject({
      outcome: "unchanged",
    });
    expect(await member(owner, team.id, disabled)).toEqual({
      outcome: "not_member",
    });
    expect(await member(owner, team.id, outsider)).toEqual({
      outcome: "not_member",
    });
    expect(await member(joiner, team.id, owner)).toEqual({
      outcome: "actor_inactive",
    });

    const detail = await teams().get(workspaceId, team.id);
    expect(detail?.members.map((m) => m.userId)).toEqual([idOf(joiner)]);
    expect(detail?.members[0]?.addedBy).toBe(idOf(owner));

    const written = await db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.ownerId, workspaceId),
          eq(receipts.operation, "add_team_member"),
        ),
      );
    expect(written).toHaveLength(1);
    expect(written[0]?.targetRef).toEqual({
      user_id: idOf(joiner),
      workspace_id: workspaceId,
    });
    expect(written[0]?.result).toEqual({
      team_id: team.id,
      team_name: team.name,
    });
    expect(written[0]?.actor).toMatchObject({ actor_user_id: idOf(owner) });
    expect(written[0]?.requestId).toBe(owner.requestId);

    expect(await member(owner, team.id, joiner, false)).toMatchObject({
      outcome: "removed",
      team: { memberCount: 0 },
    });
    expect(await member(owner, team.id, joiner, false)).toMatchObject({
      outcome: "unchanged",
    });
    // Rejoining is a new row; the old one stays as history.
    await member(owner, team.id, joiner);
    expect(
      await db
        .select()
        .from(memberTeamMembers)
        .where(eq(memberTeamMembers.teamId, team.id)),
    ).toHaveLength(2);
  });

  test("the team list counts each team's current members", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const first = await person(workspaceId, "member");
    const second = await person(workspaceId, "member");
    const team = await newTeam(owner, "a-staffed");
    const empty = await newTeam(owner, "b-empty");

    await member(owner, team.id, first);
    await member(owner, team.id, second);
    await member(owner, team.id, first, false);

    expect(
      (await teams().list(workspaceId, 50)).map((t) => [t.id, t.memberCount]),
    ).toEqual([
      [team.id, 1],
      [empty.id, 0],
    ]);
  });

  test("a person's joined teams are the live teams they are in now", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const mine = await person(workspaceId, "member");
    const other = await person(workspaceId, "member");
    const kept = await newTeam(owner, "b-kept");
    const left = await newTeam(owner, "c-left");
    const deleted = await newTeam(owner, "a-deleted");
    const theirs = await newTeam(owner, "d-theirs");
    for (const team of [kept, left, deleted])
      await member(owner, team.id, mine);
    await member(owner, theirs.id, other);
    await member(owner, left.id, mine, false);
    await teams().delete({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: deleted.id,
    });

    const joined = (caller: Caller) =>
      teams().listJoined(workspaceId, idOf(caller), 50);
    expect(await joined(mine)).toEqual([{ id: kept.id, name: "b-kept" }]);
    expect(await joined(other)).toEqual([{ id: theirs.id, name: "d-theirs" }]);
    expect(await teams().listJoined(await workspace(), idOf(mine), 50)).toEqual(
      [],
    );

    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(mine)));
    expect(await joined(mine)).toEqual([]);
  });

  test("adding a member queues behind a suspension of them instead of deadlocking it", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    // The suspension below locks the lower user_id first; make that the
    // joiner, the order in which the add used to deadlock.
    let joiner = await person(workspaceId, "member");
    while (idOf(joiner) > idOf(owner))
      joiner = await person(workspaceId, "member");
    const team = await newTeam(owner);

    // Replays setAccess's lock order: both users, then memberships in
    // user_id order.
    const suspender = await pool.connect();
    try {
      await suspender.query("BEGIN");
      await suspender.query(
        "SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR SHARE",
        [[idOf(owner), idOf(joiner)]],
      );
      await suspender.query(
        "SELECT user_id FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [workspaceId, idOf(joiner)],
      );
      const added = member(owner, team.id, joiner);
      const waiting = async () =>
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          )
        ).rowCount;
      for (let i = 0; i < 100 && !(await waiting()); i++) {
        await Bun.sleep(20);
      }
      expect(await waiting()).toBeGreaterThan(0);
      await suspender.query(
        "SELECT user_id FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [workspaceId, idOf(owner)],
      );
      await suspender.query("COMMIT");
      expect(await added).toMatchObject({ outcome: "added" });
    } finally {
      suspender.release();
    }
  });

  test("a reused receipt id fails the write rather than reading as a name clash", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const receiptId = randomUUID();
    const create = (name: string) =>
      teams().create({
        actor: acting(owner),
        receiptId,
        teamId: randomUUID(),
        name,
      });
    expect(await create("first")).toMatchObject({ outcome: "created" });
    await expect(create("second")).rejects.toThrow();
    const team = await newTeam(owner);
    await expect(
      teams().rename({
        actor: acting(owner),
        receiptId,
        teamId: team.id,
        name: "third",
      }),
    ).rejects.toThrow();
  });
});
