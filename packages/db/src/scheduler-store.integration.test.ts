import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTempDatabase, type TempDatabase } from "@agent-platform/testkit";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import { sessions, unassignedSessions } from "./schema.ts";

/**
 * Real PostgreSQL only: PGlite has a single connection, so it cannot show
 * two reservations racing for the last slot. Opt in with QUEUE_DATABASE_URL.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgresSchedulerStore under concurrent reservations", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "scheduler_race" });
    pool = new Pool({ connectionString: database.url, max: 20 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  test("only one of two overlapping passes gets the pass lock", async () => {
    const store = createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
    });
    const [first, second] = await Promise.all([
      store.acquirePassLock(),
      store.acquirePassLock(),
    ]);
    const held = [first, second].filter((r) => r !== null);
    expect(held).toHaveLength(1);
    await held[0]?.();
    const again = await store.acquirePassLock();
    expect(again).not.toBeNull();
    await again?.();
  });

  test("15 concurrent reservations from an empty pool yield exactly slotLimit intents", async () => {
    const store = createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
    });
    const ids: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const id = crypto.randomUUID();
      ids.push(id);
      await db.insert(sessions).values({
        id,
        ownerId: "race",
        repoUrl: "https://example.invalid/repo.git",
        branch: `session/${id}`,
      });
      await db.insert(unassignedSessions).values({ sessionId: id });
    }
    // Two passes each believe 10 slots are free and reserve concurrently.
    const attempts = [...ids, ...ids].map((sessionId) =>
      store.reserveLaunch({
        backend: "local_docker",
        now: new Date(),
        sessionId,
        slotLimit: 10,
      }),
    );
    const results = await Promise.all(attempts);
    const reserved = results.filter((r) => r !== null);
    expect(reserved).toHaveLength(10);
    expect(new Set(reserved.map((r) => r?.sessionId)).size).toBe(10);
    expect((await store.inspectDemand({ limit: 0 })).activeExecutionCount).toBe(
      10,
    );
  }, 60_000);
});
