import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretKey,
} from "@werft-ai/platform";
import { fakeGitHubClientSecret } from "@werft-ai/platform/testing/github";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresGitHubAppStore } from "./github-apps.ts";
import { createPostgresGitHubOAuthStore } from "./github-oauth.ts";
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
  clientId: `Iv23li${appId}`,
  permissions: { contents: "write" as const, metadata: "read" as const },
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
    expect(await store.find(ws, "author")).toBeNull();

    const set = owner();
    const stored = await store.put(ws, "author", profile(11), first, set);
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
    expect(await store.credentials("author")).toContainEqual(
      expect.objectContaining({
        id: stored.app.id,
        appId: 11,
        privateKey: first,
      }),
    );

    const second = pemOf();
    const replaced = await store.put(
      ws,
      "author",
      profile(12),
      second,
      owner(),
    );
    expect(replaced).toMatchObject({
      outcome: "stored",
      app: { id: stored.app.id, appId: 12 },
    });
    const held = (await store.credentials("author")).find(
      (app) => app.workspaceId === ws,
    );
    expect(held?.privateKey).toBe(second);
    expect(held?.updatedAt.getTime()).toBeGreaterThan(
      stored.app.updatedAt.getTime(),
    );

    const removed = owner();
    expect(await store.delete(ws, "author", removed)).toEqual({
      outcome: "deleted",
      appId: 12,
    });
    expect(await store.find(ws, "author")).toBeNull();
    expect(
      (await store.credentials("author")).some((app) => app.workspaceId === ws),
    ).toBe(false);
    const leftover = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${stored.app.id}`));
    expect(leftover).toEqual([]);
    expect(await store.delete(ws, "author", owner())).toEqual({
      outcome: "not_found",
    });

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
        result: {
          app_id: 11,
          role: "author",
          permissions: { contents: "write", metadata: "read" },
          warnings: [],
        },
        status: "succeeded",
      },
      {
        operation: "set_github_app",
        result: {
          app_id: 12,
          role: "author",
          permissions: { contents: "write", metadata: "read" },
          warnings: [],
        },
        status: "succeeded",
      },
      {
        operation: "delete_github_app",
        result: { app_id: 12, role: "author" },
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
    expect(
      await store.put(ws, "author", profile(21), pemOf(), member()),
    ).toEqual({
      outcome: "outranked",
    });
    const admin = await person(ws, "admin");
    const audit = admin();
    await db
      .delete(memberships)
      .where(eq(memberships.userId, audit.principal.actor?.userId ?? ""));
    expect(await store.put(ws, "author", profile(21), pemOf(), audit)).toEqual({
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
      store.put(ws, "author", profile(31), pemOf(), owner()),
      store.put(ws, "author", profile(32), pemOf(), owner()),
    ]);
    expect(results.map(({ outcome }) => outcome)).toEqual(["stored", "stored"]);
    const rows = await db
      .select()
      .from(githubApps)
      .where(eq(githubApps.workspaceId, ws));
    expect(rows).toHaveLength(1);
  });

  test("one App per workspace and role; the author's calls never reach the reviewer's row or key", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const reviewerKey = pemOf();
    expect(
      await store.put(ws, "reviewer", profile(51), reviewerKey, owner()),
    ).toEqual({ outcome: "no_author_app" });
    expect(await store.find(ws, "reviewer")).toBeNull();

    const author = await store.put(ws, "author", profile(52), pemOf(), owner());
    if (author.outcome !== "stored") throw new Error(author.outcome);
    expect(
      await store.put(ws, "reviewer", profile(52), pemOf(), owner()),
    ).toEqual({ outcome: "same_app" });
    const reviewer = await store.put(
      ws,
      "reviewer",
      profile(51),
      reviewerKey,
      owner(),
    );
    if (reviewer.outcome !== "stored") throw new Error(reviewer.outcome);
    expect(
      await store.put(ws, "author", profile(51), pemOf(), owner()),
    ).toEqual({ outcome: "same_app" });
    expect(author.app.id).not.toBe(reviewer.app.id);
    expect(
      (await store.credentials("author"))
        .filter((app) => app.workspaceId === ws)
        .map((app) => app.appId),
    ).toEqual([52]);
    // Replacing the author App updates its own row, not the reviewer's.
    const replaced = await store.put(
      ws,
      "author",
      profile(55),
      pemOf(),
      owner(),
    );
    expect(replaced).toMatchObject({
      outcome: "stored",
      app: { id: author.app.id, appId: 55 },
    });
    await store.delete(ws, "author", owner());

    const [kept] = await store.credentials("reviewer", ws);
    expect(kept).toMatchObject({ id: reviewer.app.id, appId: 51 });
    expect(kept?.privateKey).toBe(reviewerKey);
    expect(await store.find(ws, "reviewer")).toMatchObject({
      id: reviewer.app.id,
      updatedAt: reviewer.app.updatedAt,
    });

    // The constraint itself, not only the store's upsert, keeps it to one.
    const duplicate = await db
      .insert(githubApps)
      .values({
        id: randomUUID(),
        workspaceId: ws,
        role: "reviewer",
        ...profile(53),
        permissionsCheckedAt: new Date(),
      })
      .then(
        () => null,
        (error: unknown) => error as { cause?: { constraint?: string } },
      );
    expect(duplicate?.cause?.constraint).toBe(
      "github_apps_workspace_role_uniq",
    );
    const unknownRole = pool.query(
      `INSERT INTO github_apps (id, workspace_id, role, app_id, slug, name, html_url, api_base)
       VALUES ($1, $2, 'admin', 54, 's', 'n', 'https://github.com/apps/s', 'https://api.github.com')`,
      [randomUUID(), ws],
    );
    await expect(unknownRole).rejects.toThrow(/github_apps_role_check/);
  });

  test("one App put into both roles at once lands in one role only", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    await store.put(ws, "author", profile(61), pemOf(), owner());
    const outcomes = await Promise.all([
      store.put(ws, "author", profile(62), pemOf(), owner()),
      store.put(ws, "reviewer", profile(62), pemOf(), owner()),
    ]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
      "same_app",
      "stored",
    ]);
    const rows = await db
      .select({ role: githubApps.role, appId: githubApps.appId })
      .from(githubApps)
      .where(eq(githubApps.workspaceId, ws));
    expect(rows.filter((row) => row.appId === 62)).toHaveLength(1);
  });

  // The key read can land after a delete that committed past the row read.
  test("a row whose key is already gone reads as no App", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const stored = await store.put(ws, "author", profile(41), pemOf(), owner());
    if (stored.outcome !== "stored") throw new Error(stored.outcome);
    await db
      .delete(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${stored.app.id}`));
    expect(await store.find(ws, "author")).toBeNull();
  });

  test("user linking reads the author App's client id; a reviewer App or none gives no client", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    expect(await oauth.status(ws)).toEqual({
      authorApp: false,
      clientId: null,
      clientSecretSet: false,
    });
    await store.put(ws, "reviewer", profile(61), pemOf(), owner());
    expect((await oauth.status(ws)).authorApp).toBe(false);
    await store.put(ws, "author", profile(62), pemOf(), owner());
    expect(await oauth.status(ws.toUpperCase())).toEqual({
      authorApp: true,
      clientId: "Iv23li62",
      clientSecretSet: false,
    });
    // No secret is set, so there is no client to link with yet.
    expect(await oauth.client(ws)).toBeNull();
    expect(
      await createPostgresGitHubOAuthStore(db, null).client(ws),
    ).toBeNull();
  });

  test("a read of the App a replacement took out does not land on the new one", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const first = await store.put(ws, "author", profile(71), pemOf(), owner());
    if (first.outcome !== "stored") throw new Error(first.outcome);
    const second = await store.put(ws, "author", profile(72), pemOf(), owner());
    if (second.outcome !== "stored") throw new Error(second.outcome);
    expect(second.app.id).toBe(first.app.id);

    const read = { contents: "read" as const, metadata: "read" as const };
    await store.recordPermissions(first.app.id, 71, read, "Iv23listale");
    expect((await oauth.status(ws)).clientId).toBe("Iv23li72");
    expect((await store.find(ws, "author"))?.permissions).toEqual(
      profile(72).permissions,
    );

    await store.recordPermissions(first.app.id, 72, read, "Iv23linew");
    expect((await oauth.status(ws)).clientId).toBe("Iv23linew");
    expect((await store.find(ws, "author"))?.permissions).toEqual(read);
  });

  test("a client secret is sealed under the author App, kept across a new key, dropped with another App", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    await store.put(ws, "author", profile(91), pemOf(), owner());
    const typed = fakeGitHubClientSecret();
    const audit = owner();
    expect(await oauth.putClientSecret(ws, typed, audit, "Iv23li91")).toEqual({
      outcome: "stored",
    });
    expect((await oauth.status(ws)).clientSecretSet).toBe(true);
    const client = await oauth.client(ws);
    expect(client?.clientId).toBe("Iv23li91");
    expect(client?.clientSecret === typed).toBe(true);

    const sealed = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.workspaceId, ws));
    expect(sealed.length > 0).toBe(true);
    expect(JSON.stringify(sealed).includes(typed)).toBe(false);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, audit.receiptId));
    const result = receipt?.result as { purpose?: string; last4?: string };
    expect(result.purpose).toBe("oauth_client_secret");
    expect(result.last4?.length === 4 && typed.endsWith(result.last4)).toBe(
      true,
    );
    expect(JSON.stringify(receipt).includes(typed)).toBe(false);

    await store.put(ws, "author", profile(91), pemOf(), owner());
    expect((await oauth.client(ws))?.clientSecret === typed).toBe(true);

    await store.put(ws, "author", profile(92), pemOf(), owner());
    expect(await oauth.status(ws)).toEqual({
      authorApp: true,
      clientId: "Iv23li92",
      clientSecretSet: false,
    });
    // A boolean: a client left behind would print its secret.
    expect((await oauth.client(ws)) === null).toBe(true);
  });

  test("a client secret typed for an App a replacement took out is refused, nothing stored", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    await store.put(ws, "author", profile(81), pemOf(), owner());
    await store.put(ws, "author", profile(82), pemOf(), owner());
    const audit = owner();
    // Refused under the lock before the value is sealed, so none is needed.
    expect(await oauth.putClientSecret(ws, "", audit, "Iv23li81")).toEqual({
      outcome: "client_changed",
    });
    expect((await oauth.status(ws)).clientSecretSet).toBe(false);
    expect(
      await db.select().from(receipts).where(eq(receipts.id, audit.receiptId)),
    ).toEqual([]);
  });
});
