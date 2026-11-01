import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresCatalogRepositoryStore } from "./catalog-repositories.ts";
import * as schema from "./schema.ts";
import {
  installationProfiles,
  memberships,
  receipts,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("catalog repositories on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "catalog_repos_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: `${role} person`,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return {
      workspaceId,
      userId,
      actor: {
        principal: { kind: "user" as const, id: userId },
        actor_user_id: userId,
        agent_id: null,
      },
      requestId: null,
    };
  }

  const repo = (n: number) => ({
    githubRepositoryId: 1000 + n,
    owner: "Acme",
    name: `App${n}`,
    url: `https://github.com/Acme/App${n}.git`,
    branch: "main",
  });

  test("seeds only an empty table, then adds, renames a branch and removes under the rules", async () => {
    const store = createPostgresCatalogRepositoryStore(db);
    const seedEntry = {
      id: "seeded",
      owner: "acme",
      name: "seeded",
      url: "https://github.com/acme/seeded.git",
      branch: "trunk",
      profiles: ["coding"],
    };
    // Never seeded: the catalog keeps the operator file.
    expect(await store.readCatalog()).toBeNull();
    // Before bootstrap: rows go in, no receipt (no workspace to own it).
    expect(await store.seed({ entries: async () => [seedEntry] })).toEqual([
      "seeded",
    ]);
    expect((await store.readCatalog())?.map((row) => row.id)).toEqual([
      "seeded",
    ]);
    expect(await db.select().from(receipts)).toEqual([]);
    // A filled table never reads the file again.
    let read = false;
    expect(
      await store.seed({
        entries: async () => {
          read = true;
          return [{ ...seedEntry, id: "other" }];
        },
      }),
    ).toEqual([]);
    expect(read).toBe(false);

    const workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "Acme",
    });
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");

    const refused = await store.add({
      ...member,
      receiptId: randomUUID(),
      id: { base: "app1" },
      reserved: new Set(),
      ...repo(1),
    });
    expect(refused).toEqual({ outcome: "actor_inactive" });

    const receiptId = randomUUID();
    const added = await store.add({
      ...owner,
      receiptId,
      id: { base: "app1" },
      reserved: new Set(),
      ...repo(1),
    });
    expect(added).toMatchObject({
      outcome: "stored",
      repository: {
        id: "app1",
        github_repository_id: 1001,
        source: "console",
        version: 1,
        profiles: null,
      },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(receipt).toMatchObject({
      operation: "add_repository",
      ownerId: workspaceId,
      result: {
        repository_id: "app1",
        full_name: "Acme/App1",
        branch: "main",
      },
    });

    // The same GitHub repository by id, or by name in another case.
    for (const twin of [repo(1), { ...repo(9), owner: "acme", name: "app1" }]) {
      expect(
        await store.add({
          ...owner,
          receiptId: randomUUID(),
          id: { base: "x" },
          reserved: new Set(),
          ...twin,
        }),
      ).toEqual({ outcome: "already_added" });
    }
    // A reserved (file) id, asked for exactly or numbered past.
    expect(
      await store.add({
        ...owner,
        receiptId: randomUUID(),
        id: { exact: "tool" },
        reserved: new Set(["tool"]),
        ...repo(2),
      }),
    ).toEqual({ outcome: "id_taken" });
    expect(
      await store.add({
        ...owner,
        receiptId: randomUUID(),
        id: { base: "tool" },
        reserved: new Set(["tool"]),
        ...repo(2),
      }),
    ).toMatchObject({ outcome: "stored", repository: { id: "tool-2" } });

    expect(
      await store.setBranch({
        ...owner,
        receiptId: randomUUID(),
        id: "app1",
        branch: "develop",
        version: 2,
      }),
    ).toEqual({ outcome: "revision_conflict" });
    expect(
      await store.setBranch({
        ...owner,
        receiptId: randomUUID(),
        id: "app1",
        branch: "develop",
        version: 1,
      }),
    ).toMatchObject({
      outcome: "stored",
      repository: { branch: "develop", version: 2 },
    });

    // A ceiling that names it holds it; a retired one does not.
    await db.insert(installationProfiles).values({
      id: "coding",
      name: null,
      version: 1,
      origin: "catalog",
      definition: {},
      permissionMode: "default",
      fingerprint: "f",
      repositoryIds: ["app1"],
    });
    expect(
      await store.remove({ ...owner, receiptId: randomUUID(), id: "app1" }),
    ).toEqual({ outcome: "in_use", profiles: ["coding"], agents: [] });
    await db
      .update(installationProfiles)
      .set({ retiredAt: new Date(), retiredBy: owner.userId })
      .where(eq(installationProfiles.id, "coding"));
    expect(
      await store.remove({ ...owner, receiptId: randomUUID(), id: "app1" }),
    ).toEqual({ outcome: "removed" });
    expect(
      await store.remove({ ...owner, receiptId: randomUUID(), id: "app1" }),
    ).toEqual({ outcome: "not_found" });
    expect((await store.listActive()).map((row) => row.id)).toEqual([
      "seeded",
      "tool-2",
    ]);

    // Removed, it can come back, under an id never handed out before.
    expect(
      await store.add({
        ...owner,
        receiptId: randomUUID(),
        id: { base: "app1" },
        reserved: new Set(),
        ...repo(1),
      }),
    ).toMatchObject({ outcome: "stored", repository: { id: "app1-2" } });
    // And a seed with a workspace present leaves its receipt; the table is
    // filled, so nothing is seeded.
    expect(await store.seed({ entries: async () => [seedEntry] })).toEqual([]);
  });
});
