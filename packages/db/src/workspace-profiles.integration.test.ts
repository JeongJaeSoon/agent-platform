import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { type Caller, callerFor, type TeamActor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { findPgError } from "./control-shared.ts";
import * as schema from "./schema.ts";
import {
  memberships,
  receipts,
  users,
  workspaceProfiles,
  workspaces,
} from "./schema.ts";
import { createPostgresWorkspaceProfileStore } from "./workspace-profiles.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("workspace profile versions on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "workspace_profiles_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace(slug = `acme-${randomUUID().slice(0, 8)}`) {
    const workspaceId = randomUUID();
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return { workspaceId, slug };
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

  function acting(caller: Caller): TeamActor {
    return {
      principal: caller,
      workspaceId: caller.ownerId,
      userId: caller.actor?.userId ?? "",
    };
  }

  const store = () => createPostgresWorkspaceProfileStore(db);

  function save(by: Caller, name = "strict-review") {
    return store().create({
      actor: acting(by),
      receiptId: randomUUID(),
      name,
      baseProfileId: "claude-coding-real",
      base: {
        fingerprint: "fp-1",
        runtimeVersion: "0.3.270",
        billing: "metered",
        repositoryMode: "required",
      },
      narrowing: {
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        tools: ["Read"],
        permission_mode: "plan",
      },
    });
  }

  test("each save is the next version under a new id, with a receipt", async () => {
    const { workspaceId, slug } = await workspace();
    const owner = await person(workspaceId, "owner");
    const first = await save(owner);
    const second = await save(owner);
    if (first.outcome !== "created" || second.outcome !== "created") {
      throw new Error(`${first.outcome} ${second.outcome}`);
    }
    expect(first.record).toMatchObject({
      id: `ws_${slug}_strict-review_v1`,
      workspace_id: workspaceId,
      version: 1,
      base_profile_id: "claude-coding-real",
      base_fingerprint: "fp-1",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "plan",
      base_billing: "metered",
      retired_at: null,
    });
    expect(second.record.id).toBe(`ws_${slug}_strict-review_v2`);
    // The first version is as it was.
    const listed = (await store().listAll()).filter(
      (r) => r.workspace_id === workspaceId,
    );
    expect(listed.map((r) => [r.id, r.version])).toEqual([
      [`ws_${slug}_strict-review_v1`, 1],
      [`ws_${slug}_strict-review_v2`, 2],
    ]);
    const written = await db
      .select()
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(written.map((r) => r.operation).sort()).toEqual([
      "create_workspace_profile",
      "create_workspace_profile",
    ]);
    expect(written[0]?.targetRef).toEqual({
      resource: { kind: "workspace", id: workspaceId },
      workspace_id: workspaceId,
    });
  });

  test("two saves at once make one version each or refuse the loser as taken", async () => {
    const { workspaceId } = await workspace();
    const admin = await person(workspaceId, "admin");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => save(admin, "raced")),
    );
    const created = results.filter((r) => r.outcome === "created");
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(["created", "version_taken"]).toContain(r.outcome);
    }
    const versions = created
      .map((r) => (r.outcome === "created" ? r.record.version : 0))
      .sort();
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("a slug outside the id's alphabet falls back to the workspace id", async () => {
    const { workspaceId } = await workspace(`Acme_${randomUUID().slice(0, 4)}`);
    const owner = await person(workspaceId, "owner");
    const saved = await save(owner);
    expect(saved.outcome === "created" && saved.record.id).toBe(
      `ws_${workspaceId}_strict-review_v1`,
    );
  });

  test("a member, or an owner since disabled, writes nothing", async () => {
    const { workspaceId } = await workspace();
    const member = await person(workspaceId, "member");
    expect((await save(member)).outcome).toBe("actor_inactive");
    const owner = await person(workspaceId, "owner");
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, owner.actor?.userId ?? ""));
    expect((await save(owner)).outcome).toBe("actor_inactive");
    const rows = await db
      .select()
      .from(workspaceProfiles)
      .where(eq(workspaceProfiles.workspaceId, workspaceId));
    expect(rows).toEqual([]);
  });

  test("retires once, unchanged after, and never another workspace's version", async () => {
    const { workspaceId } = await workspace();
    const owner = await person(workspaceId, "owner");
    const saved = await save(owner);
    if (saved.outcome !== "created") throw new Error(saved.outcome);
    const retire = (by: Caller) =>
      store().retire({
        actor: acting(by),
        receiptId: randomUUID(),
        profileId: saved.record.id,
      });

    const other = await workspace();
    const stranger = await person(other.workspaceId, "owner");
    expect((await retire(stranger)).outcome).toBe("not_found");

    const retired = await retire(owner);
    expect(retired.outcome).toBe("retired");
    expect(
      retired.outcome === "retired" && retired.record.retired_at,
    ).toBeInstanceOf(Date);
    expect((await retire(owner)).outcome).toBe("unchanged");
    const written = await db
      .select({ operation: receipts.operation })
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(written.map((r) => r.operation).sort()).toEqual([
      "create_workspace_profile",
      "retire_workspace_profile",
    ]);
  });

  test("the table refuses an id outside the workspace prefix", async () => {
    const { workspaceId } = await workspace();
    const owner = await person(workspaceId, "owner");
    const insert = async () =>
      db.insert(workspaceProfiles).values({
        id: "claude-coding-real",
        workspaceId,
        name: "x",
        version: 1,
        baseProfileId: "b",
        baseFingerprint: "f",
        baseRuntimeVersion: "1",
        baseBilling: "metered",
        baseRepositoryMode: "required",
        model: "m",
        models: ["m"],
        tools: [],
        permissionMode: "plan",
        createdBy: owner.actor?.userId ?? "",
      });
    const refused = await insert().then(
      () => null,
      (error: unknown) => findPgError(error, "23514"),
    );
    expect(refused?.constraint).toBe("workspace_profiles_id_check");
  });
});
