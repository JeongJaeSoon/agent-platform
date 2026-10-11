import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SESSION_SCOPE_VALUES } from "@agent-platform/contracts";
import {
  type AcceptInviteInput,
  type ActingOwner,
  BootstrapDoneError,
  callerFor,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { bootstrapOwner } from "./identity.ts";
import { createPostgresInviteStore } from "./invites.ts";
import * as schema from "./schema.ts";
import {
  invites,
  memberships,
  receipts,
  users,
  webSessions,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

function hashOf(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token).digest());
}

integration("invite store on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: ReturnType<typeof createPostgresInviteStore>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "invites_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresInviteStore(db);
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

  async function account(email = `${randomUUID()}@example.invalid`) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash: `hash-${userId}`,
      displayName: "Someone",
    });
    return { userId, email, passwordHash: `hash-${userId}` };
  }

  async function member(workspaceId: string, role: "owner" | "member") {
    const created = await account();
    await db
      .insert(memberships)
      .values({ workspaceId, userId: created.userId, role });
    return created.userId;
  }

  function acting(workspaceId: string, userId: string): ActingOwner {
    return {
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: [...SESSION_SCOPE_VALUES],
        },
        { kind: "web" },
        randomUUID(),
      ),
      workspaceId,
      userId,
    };
  }

  async function issue(
    actor: ActingOwner,
    email: string,
    options: { role?: "owner" | "member"; ttlMs?: number } = {},
  ) {
    const token = `apv_${randomUUID()}`;
    const receiptId = randomUUID();
    const result = await store.createInvite({
      id: randomUUID(),
      actor,
      email,
      role: options.role ?? "member",
      tokenHash: hashOf(token),
      ttlMs: options.ttlMs ?? 7 * DAY_MS,
      receiptId,
    });
    return { result, token, receiptId };
  }

  function newAccount(token: string, email = "x"): AcceptInviteInput {
    return {
      tokenHash: hashOf(token),
      account: {
        kind: "new",
        userId: randomUUID(),
        passwordHash: `new-hash-${email}`,
        displayName: "New",
      },
      session: {
        id: randomUUID(),
        tokenHash: hashOf(randomUUID()),
        ttlMs: DAY_MS,
        userAgent: null,
        maxLive: 10,
      },
      receiptId: randomUUID(),
    };
  }

  async function receipt(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    return row;
  }

  test("an invite keeps only its token's hash and expires on the database clock", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const { result, token, receiptId } = await issue(
      acting(ws, owner),
      "hash-only@example.invalid",
    );
    if (result.outcome !== "created") throw new Error(result.outcome);
    const [row] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, result.invite.id));
    expect(Buffer.from(row?.tokenHash ?? []).toString("hex")).toBe(
      Buffer.from(hashOf(token)).toString("hex"),
    );
    expect(JSON.stringify(row)).not.toContain(token);
    const ttl =
      (row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0);
    expect(Math.abs(ttl - 7 * DAY_MS)).toBeLessThan(5_000);
    expect(result.invite.status).toBe("pending");
    const written = await receipt(receiptId);
    expect(written?.operation).toBe("invite_member");
    expect(JSON.stringify(written?.actor)).toContain(owner);
  });

  test("issuing again revokes the address's live invite", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const first = await issue(actor, "again@example.invalid");
    const second = await issue(actor, "again@example.invalid");
    expect(second.result.outcome).toBe("created");
    expect(await store.peekInvite(hashOf(first.token))).toEqual({
      outcome: "expired",
    });
    expect(await store.acceptInvite(newAccount(first.token))).toEqual({
      outcome: "expired",
    });
    expect((await store.peekInvite(hashOf(second.token))).outcome).toBe(
      "pending",
    );
  });

  test("a live member's address and a demoted actor are refused", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const other = await account();
    await db
      .insert(memberships)
      .values({ workspaceId: ws, userId: other.userId, role: "member" });
    expect((await issue(acting(ws, owner), other.email)).result).toEqual({
      outcome: "already_member",
    });
    const demoted = await member(ws, "member");
    expect(
      (await issue(acting(ws, demoted), "late@example.invalid")).result,
    ).toEqual({ outcome: "actor_inactive" });
  });

  test("a new address gets an account, a membership, a session and a receipt, once", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const { token } = await issue(acting(ws, owner), "fresh@example.invalid", {
      role: "owner",
    });
    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "pending",
      email: "fresh@example.invalid",
      existingUser: null,
    });
    const input = newAccount(token);
    const accepted = await store.acceptInvite(input);
    expect(accepted).toMatchObject({
      outcome: "accepted",
      userId: input.account.userId,
      workspaceId: ws,
      role: "owner",
    });
    const [joined] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, ws),
          eq(memberships.userId, input.account.userId),
        ),
      );
    expect(joined?.role).toBe("owner");
    const [session] = await db
      .select()
      .from(webSessions)
      .where(eq(webSessions.id, input.session.id));
    expect(session?.userId).toBe(input.account.userId);
    const written = await receipt(input.receiptId);
    expect(written?.operation).toBe("accept_invite");
    expect(JSON.stringify(written?.actor)).toContain(input.account.userId);
    expect(await store.acceptInvite(newAccount(token))).toEqual({
      outcome: "used",
    });
    expect(await store.peekInvite(hashOf(token))).toEqual({ outcome: "used" });
  });

  test("an existing account joins only with the hash it was verified against, and keeps its password", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const existing = await account("known@example.invalid");
    const { token } = await issue(acting(ws, owner), existing.email);
    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "pending",
      email: existing.email,
      existingUser: {
        id: existing.userId,
        passwordHash: existing.passwordHash,
      },
    });
    const base = newAccount(token);
    expect(
      await store.acceptInvite({
        ...base,
        account: {
          kind: "existing",
          userId: existing.userId,
          verifiedPasswordHash: "an older hash",
        },
      }),
    ).toEqual({ outcome: "account_changed" });
    expect(
      await store.acceptInvite({
        ...base,
        account: {
          kind: "existing",
          userId: existing.userId,
          verifiedPasswordHash: existing.passwordHash,
        },
      }),
    ).toMatchObject({ outcome: "accepted", userId: existing.userId });
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.id, existing.userId));
    expect(row?.passwordHash).toBe(existing.passwordHash);
    expect(row?.displayName).toBe("Someone");
  });

  test("revoking: pending, then again, then an accepted invite", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const pending = await issue(actor, "revoke@example.invalid");
    if (pending.result.outcome !== "created") throw new Error("not created");
    const id = pending.result.invite.id;
    expect(
      await store.revokeInvite({ id, actor, receiptId: randomUUID() }),
    ).toEqual({ outcome: "revoked" });
    expect(
      await store.revokeInvite({ id, actor, receiptId: randomUUID() }),
    ).toEqual({ outcome: "already_revoked" });
    expect(await store.peekInvite(hashOf(pending.token))).toEqual({
      outcome: "expired",
    });
    const used = await issue(actor, "used@example.invalid");
    if (used.result.outcome !== "created") throw new Error("not created");
    await store.acceptInvite(newAccount(used.token));
    expect(
      await store.revokeInvite({
        id: used.result.invite.id,
        actor,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "accepted" });
    expect(
      await store.revokeInvite({
        id: randomUUID(),
        actor,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "not_found" });
    const statuses = (await store.listInvites(ws, 10)).map((i) => i.status);
    expect(statuses.sort()).toEqual(["accepted", "revoked"]);
  });

  test("an expired invite cannot be accepted and lists as expired", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const { token } = await issue(actor, "slow@example.invalid", { ttlMs: 1 });
    await Bun.sleep(10);
    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "expired",
    });
    expect(await store.acceptInvite(newAccount(token))).toEqual({
      outcome: "expired",
    });
    expect((await store.listInvites(ws, 10))[0]?.status).toBe("expired");
    expect(await store.peekInvite(hashOf("never issued"))).toEqual({
      outcome: "unknown",
    });
  });

  test("two accepts of one token: exactly one account", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const { token } = await issue(actor, "twice@example.invalid");
    const results = await Promise.all([
      store.acceptInvite(newAccount(token)),
      store.acceptInvite(newAccount(token)),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "used"]);
    const created = await db
      .select()
      .from(users)
      .where(eq(users.email, "twice@example.invalid"));
    expect(created).toHaveLength(1);
  });

  test("an account created for the address mid-accept answers account_changed", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const { token } = await issue(actor, "race@example.invalid");
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'race@example.invalid', 'x', 'Race')",
        [randomUUID()],
      );
      const pending = store.acceptInvite(newAccount(token));
      await Bun.sleep(300);
      await other.query("COMMIT");
      expect(await pending).toEqual({ outcome: "account_changed" });
    } finally {
      other.release();
    }
    expect((await store.peekInvite(hashOf(token))).outcome).toBe("pending");
  });

  test("an invite that expires while the accept waits on a lock is not accepted", async () => {
    const ws = await workspace();
    const actor = acting(ws, await member(ws, "owner"));
    const existing = await account();
    const { token } = await issue(actor, existing.email, { ttlMs: 1_000 });
    const other = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        existing.userId,
      ]);
      // Takes the invite while it is live, then waits on the user row.
      pending = store.acceptInvite({
        ...newAccount(token),
        account: {
          kind: "existing",
          userId: existing.userId,
          verifiedPasswordHash: existing.passwordHash,
        },
      });
      await Bun.sleep(1_500);
      await other.query("COMMIT");
      expect(await pending).toEqual({ outcome: "expired" });
    } finally {
      other.release();
    }
    const joined = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, ws),
          eq(memberships.userId, existing.userId),
        ),
      );
    expect(joined).toHaveLength(0);
  });

  test("issuing and accepting lock the actor's user row before its membership", async () => {
    const ws = await workspace();
    const owner = await member(ws, "owner");
    const other = await pool.connect();
    try {
      // The accept order: user row, then membership.
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        owner,
      ]);
      const issued = issue(acting(ws, owner), "order@example.invalid");
      await Bun.sleep(300);
      await other.query(
        "SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [ws, owner],
      );
      await other.query("COMMIT");
      expect((await issued).result.outcome).toBe("created");
    } finally {
      other.release();
    }
  });

  test("roles: the last live owner stays, and two owners demoting each other leave one", async () => {
    const ws = await workspace();
    const first = await member(ws, "owner");
    expect(
      await store.changeMemberRole({
        userId: first,
        role: "member",
        actor: acting(ws, first),
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "last_owner" });
    expect(
      await store.changeMemberRole({
        userId: randomUUID(),
        role: "member",
        actor: acting(ws, first),
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "not_found" });
    const second = await member(ws, "owner");
    const results = await Promise.all([
      store.changeMemberRole({
        userId: second,
        role: "member",
        actor: acting(ws, first),
        receiptId: randomUUID(),
      }),
      store.changeMemberRole({
        userId: first,
        role: "member",
        actor: acting(ws, second),
        receiptId: randomUUID(),
      }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "actor_inactive",
      "changed",
    ]);
    const owners = (await store.listMembers(ws)).filter(
      (m) => m.role === "owner",
    );
    expect(owners).toHaveLength(1);
  });

  test("a member list shows the earlier of membership and account disabling", async () => {
    const ws = await workspace();
    const userId = await member(ws, "member");
    const at = new Date("2026-10-01T00:00:00.000Z");
    await db.update(users).set({ disabledAt: at }).where(eq(users.id, userId));
    const listed = (await store.listMembers(ws)).find(
      (m) => m.userId === userId,
    );
    expect(listed?.disabledAt?.toISOString()).toBe(at.toISOString());
  });
});

// Owner recovery counts live owners across the install, so it gets a database
// of its own.
integration("invites across owner recovery on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "invites_recovery_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("recovering an owner revokes every invite issued before it", async () => {
    const store = createPostgresInviteStore(db);
    const ws = randomUUID();
    await db.insert(workspaces).values({ id: ws, slug: "recover", name: "r" });
    const owner = randomUUID();
    await db.insert(users).values({
      id: owner,
      email: "lost@example.invalid",
      passwordHash: "old",
      displayName: "Lost",
    });
    await db
      .insert(memberships)
      .values({ workspaceId: ws, userId: owner, role: "owner" });
    const token = `apv_${randomUUID()}`;
    const created = await store.createInvite({
      id: randomUUID(),
      actor: {
        principal: callerFor(
          {
            kind: "user",
            id: owner,
            workspace_id: ws,
            role: "owner",
            scopes: [...SESSION_SCOPE_VALUES],
          },
          { kind: "web" },
          randomUUID(),
        ),
        workspaceId: ws,
        userId: owner,
      },
      email: "outsider@example.invalid",
      role: "owner",
      tokenHash: hashOf(token),
      ttlMs: 7 * DAY_MS,
      receiptId: randomUUID(),
    });
    expect(created.outcome).toBe("created");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, owner));

    await bootstrapOwner(db, {
      userId: randomUUID(),
      email: "lost@example.invalid",
      passwordHash: "recovered",
      displayName: "Lost",
      workspaceId: randomUUID(),
      workspaceSlug: "unused",
      workspaceName: "unused",
      bootstrapTokenHash: hashOf("recovery token"),
      receiptId: randomUUID(),
    });

    expect(await store.peekInvite(hashOf(token))).toEqual({
      outcome: "expired",
    });
    expect((await store.listInvites(ws, 10))[0]?.status).toBe("revoked");
  });
});

integration("owner recovery racing an owner invite on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "invites_recovery_race_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("recovery stops when an accept it waited on created a live owner", async () => {
    const ws = randomUUID();
    await db.insert(workspaces).values({ id: ws, slug: "race", name: "r" });
    const lost = randomUUID();
    await db.insert(users).values({
      id: lost,
      email: "gone@example.invalid",
      passwordHash: "old",
      displayName: "Gone",
    });
    await db.insert(memberships).values({
      workspaceId: ws,
      userId: lost,
      role: "owner",
      disabledAt: new Date(),
    });
    const inviteId = randomUUID();
    await db.insert(invites).values({
      id: inviteId,
      workspaceId: ws,
      email: "heir@example.invalid",
      role: "owner",
      tokenHash: hashOf(`apv_${randomUUID()}`),
      invitedBy: lost,
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    const heir = randomUUID();
    const accept = await pool.connect();
    try {
      // What an accept holds and writes before it commits.
      await accept.query("BEGIN");
      await accept.query("SELECT 1 FROM invites WHERE id = $1 FOR UPDATE", [
        inviteId,
      ]);
      await accept.query(
        "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'heir@example.invalid', 'x', 'Heir')",
        [heir],
      );
      await accept.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [ws, heir],
      );
      await accept.query(
        "UPDATE invites SET accepted_at = clock_timestamp() WHERE id = $1",
        [inviteId],
      );
      const recovery = bootstrapOwner(db, {
        userId: randomUUID(),
        email: "gone@example.invalid",
        passwordHash: "recovered",
        displayName: "Gone",
        workspaceId: randomUUID(),
        workspaceSlug: "unused",
        workspaceName: "unused",
        bootstrapTokenHash: hashOf("second recovery token"),
        receiptId: randomUUID(),
      });
      await Bun.sleep(300);
      await accept.query("COMMIT");
      await expect(recovery).rejects.toBeInstanceOf(BootstrapDoneError);
    } finally {
      accept.release();
    }
    const [kept] = await db.select().from(users).where(eq(users.id, lost));
    expect(kept?.passwordHash).toBe("old");
  });
});
