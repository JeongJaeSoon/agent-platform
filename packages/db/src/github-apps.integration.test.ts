import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretKey,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresGitHubAppStore } from "./github-apps.ts";
import * as schema from "./schema.ts";
import {
  githubApps,
  memberships,
  receipts,
  secretValues,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];

const pemOf = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString()
    .trim();

const profile = (appId: number) => ({
  appId,
  slug: `app-${appId}`,
  name: `App ${appId}`,
  htmlUrl: `https://github.com/apps/app-${appId}`,
  apiBase: "https://api.github.com",
});

integration("the GitHub App on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "github_apps_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function workspace() {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme" });
    return id;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: `${role} person`,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return (): SecretAudit => ({
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role,
          scopes: [...scopesForRole(role)],
        },
        { kind: "web" },
        randomUUID(),
      ),
      receiptId: randomUUID(),
      roles: MANAGERS,
    });
  }

  test("registers, replaces and removes the App with its key sealed, one receipt each", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const first = pemOf();
    expect(await store.find(ws)).toBeNull();

    const set = owner();
    const stored = await store.put(ws, profile(11), first, set);
    expect(stored).toMatchObject({
      outcome: "stored",
      app: {
        workspaceId: ws,
        appId: 11,
        slug: "app-11",
        privateKey: { updatedBy: { displayName: "owner person" } },
      },
    });
    if (stored.outcome !== "stored") throw new Error("not stored");
    const [sealed] = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${stored.app.id}`));
    expect(sealed?.purpose).toBe("github_app_private_key");
    expect(Buffer.from(sealed?.ciphertext ?? []).toString()).not.toContain(
      first.split("\n")[1] ?? "",
    );
    expect(await store.credentials()).toContainEqual(
      expect.objectContaining({
        id: stored.app.id,
        appId: 11,
        privateKey: first,
      }),
    );

    const second = pemOf();
    const replaced = await store.put(ws, profile(12), second, owner());
    expect(replaced).toMatchObject({
      outcome: "stored",
      app: { id: stored.app.id, appId: 12 },
    });
    const held = (await store.credentials()).find(
      (app) => app.workspaceId === ws,
    );
    expect(held?.privateKey).toBe(second);
    expect(held?.updatedAt.getTime()).toBeGreaterThan(
      stored.app.updatedAt.getTime(),
    );

    const removed = owner();
    expect(await store.delete(ws, removed)).toEqual({
      outcome: "deleted",
      appId: 12,
    });
    expect(await store.find(ws)).toBeNull();
    expect(
      (await store.credentials()).some((app) => app.workspaceId === ws),
    ).toBe(false);
    const leftover = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${stored.app.id}`));
    expect(leftover).toEqual([]);
    expect(await store.delete(ws, owner())).toEqual({ outcome: "not_found" });

    const written = await db
      .select({
        operation: receipts.operation,
        result: receipts.result,
        status: receipts.status,
      })
      .from(receipts)
      .where(eq(receipts.ownerId, ws));
    expect(written).toEqual([
      {
        operation: "set_github_app",
        result: { app_id: 11 },
        status: "succeeded",
      },
      {
        operation: "set_github_app",
        result: { app_id: 12 },
        status: "succeeded",
      },
      {
        operation: "delete_github_app",
        result: { app_id: 12 },
        status: "succeeded",
      },
    ]);
    for (const row of await db.select().from(receipts)) {
      expect(JSON.stringify(row)).not.toContain(first.split("\n")[1] ?? "");
    }
  });

  test("a member, or someone who left, changes nothing", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const member = await person(ws, "member");
    expect(await store.put(ws, profile(21), pemOf(), member())).toEqual({
      outcome: "outranked",
    });
    const admin = await person(ws, "admin");
    const audit = admin();
    await db
      .delete(memberships)
      .where(eq(memberships.userId, audit.principal.actor?.userId ?? ""));
    expect(await store.put(ws, profile(21), pemOf(), audit)).toEqual({
      outcome: "actor_inactive",
    });
    expect(
      await db.select().from(githubApps).where(eq(githubApps.workspaceId, ws)),
    ).toEqual([]);
  });

  test("two registrations at once leave one App", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const results = await Promise.all([
      store.put(ws, profile(31), pemOf(), owner()),
      store.put(ws, profile(32), pemOf(), owner()),
    ]);
    expect(results.map(({ outcome }) => outcome)).toEqual(["stored", "stored"]);
    const rows = await db
      .select()
      .from(githubApps)
      .where(eq(githubApps.workspaceId, ws));
    expect(rows).toHaveLength(1);
  });

  // The key read can land after a delete that committed past the row read.
  test("a row whose key is already gone reads as no App", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const stored = await store.put(ws, profile(41), pemOf(), owner());
    if (stored.outcome !== "stored") throw new Error(stored.outcome);
    await db
      .delete(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${stored.app.id}`));
    expect(await store.find(ws)).toBeNull();
  });
});
