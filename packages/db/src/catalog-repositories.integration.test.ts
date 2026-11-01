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
import { memberships, receipts, users, workspaces } from "./schema.ts";

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

  async function person(workspaceId: string, role: WorkspaceRole | null) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: `${role ?? "outside"} person`,
    });
    if (role !== null) {
      await db.insert(memberships).values({ workspaceId, userId, role });
    }
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

  test("seeds only an empty table, then resolves picks to one row each and renames a branch", async () => {
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
    const outsider = await person(workspaceId, null);

    expect(
      await store.resolve({
        ...outsider,
        receiptId: randomUUID(),
        base: "app1",
        reserved: new Set(),
        ...repo(1),
      }),
    ).toEqual({ outcome: "actor_inactive" });

    // Any member may resolve: who may pick was the policy's call.
    const receiptId = randomUUID();
    const first = await store.resolve({
      ...member,
      receiptId,
      base: "app1",
      reserved: new Set(),
      ...repo(1),
    });
    expect(first).toMatchObject({
      outcome: "resolved",
      created: true,
      repository: {
        id: "app1",
        github_repository_id: 1001,
        source: "selection",
        version: 1,
        profiles: null,
      },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(receipt).toMatchObject({
      operation: "resolve_repository",
      ownerId: workspaceId,
      result: {
        repository_id: "app1",
        full_name: "Acme/App1",
        branch: "main",
      },
    });

    // The same GitHub repository, its name in another case, is the same
    // row, and leaves no receipt.
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "x",
        reserved: new Set(),
        ...repo(1),
        owner: "acme",
        name: "app1",
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: false,
      changed: false,
      repository: { id: "app1", github_repository_id: 1001, version: 1 },
    });
    // Another repository under that name never takes the row.
    const newcomer = { ...repo(9), name: "App1" };
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "app1",
        reserved: new Set(),
        ...newcomer,
      }),
    ).toEqual({ outcome: "name_held", id: "app1" });
    // Picking the renamed one moves its row to the new name and URL, which
    // frees the old name.
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "x",
        reserved: new Set(),
        ...repo(1),
        name: "App1-old",
        url: "https://github.com/Acme/App1-old.git",
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: false,
      changed: true,
      repository: {
        id: "app1",
        name: "App1-old",
        url: "https://github.com/Acme/App1-old.git",
        version: 2,
      },
    });
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "app1",
        reserved: new Set(),
        ...newcomer,
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: true,
      repository: { id: "app1-2", github_repository_id: 1009 },
    });
    // A seeded row found by name gets its GitHub id filled in.
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "seeded",
        reserved: new Set(),
        githubRepositoryId: 5000,
        owner: "ACME",
        name: "Seeded",
        url: "https://github.com/ACME/Seeded.git",
        branch: "main",
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: false,
      repository: { id: "seeded", github_repository_id: 5000, branch: "trunk" },
    });
    // A reserved (file) id is numbered past.
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "tool",
        reserved: new Set(["tool"]),
        ...repo(2),
      }),
    ).toMatchObject({ outcome: "resolved", repository: { id: "tool-2" } });

    // Two first picks at once: one row, one receipt.
    const picks = await Promise.all(
      [0, 1, 2].map(() =>
        store.resolve({
          ...owner,
          receiptId: randomUUID(),
          base: "app3",
          reserved: new Set(),
          ...repo(3),
        }),
      ),
    );
    expect(
      new Set(
        picks.map((pick) =>
          pick.outcome === "resolved" ? pick.repository.id : null,
        ),
      ),
    ).toEqual(new Set(["app3"]));
    expect(
      picks.filter((pick) => pick.outcome === "resolved" && pick.created),
    ).toHaveLength(1);

    expect(
      await store.setBranch({
        ...member,
        receiptId: randomUUID(),
        id: "app1",
        branch: "develop",
        version: 1,
      }),
    ).toEqual({ outcome: "actor_inactive" });
    expect(
      await store.setBranch({
        ...owner,
        receiptId: randomUUID(),
        id: "app1",
        branch: "develop",
        version: 1,
      }),
    ).toEqual({ outcome: "revision_conflict" });
    expect(
      await store.setBranch({
        ...owner,
        receiptId: randomUUID(),
        id: "app1",
        branch: "develop",
        version: 2,
      }),
    ).toMatchObject({
      outcome: "stored",
      repository: { branch: "develop", version: 3 },
    });
    expect((await store.listActive()).map((row) => row.id)).toEqual([
      "app1",
      "app1-2",
      "app3",
      "seeded",
      "tool-2",
    ]);
    // No agent has an active release here.
    expect((await store.agentCounts()).size).toBe(0);
  });
});
