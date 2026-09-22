import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTempDatabase, type TempDatabase } from "@agent-platform/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import { sessions, unassignedSessions, workerLaunches } from "./schema.ts";

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
  }, 60_000);

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

  test("issueBootstrapNonce writes the deadline on the database clock, not this process's", async () => {
    const store = createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
    });
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: "clock",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${id}`,
    });
    await db.insert(unassignedSessions).values({ sessionId: id });
    // The race test above keeps its ten slots; this one needs one more.
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: new Date(),
      sessionId: id,
      slotLimit: 100,
    });
    if (!intent) throw new Error("no intent");
    const dbNowMs = async () => {
      const [row] = await db
        .select({
          ms: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`,
        })
        .from(sql`(SELECT 1) AS one`);
      return Number(row?.ms);
    };
    // A process clock a minute ahead: a deadline derived from it would land
    // outside the bracket the database clock draws around the call.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    let floor: number;
    let ceiling: number;
    try {
      floor = await dbNowMs();
      await store.issueBootstrapNonce(intent);
      ceiling = await dbNowMs();
    } finally {
      Date.now = realNow;
    }
    const [row] = await db
      .select({ nonceExpiresAt: workerLaunches.nonceExpiresAt })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    const expiresAt = row?.nonceExpiresAt?.getTime() ?? Number.NaN;
    // The column keeps microseconds; the Date read back is floored to ms.
    expect(expiresAt).toBeGreaterThanOrEqual(Math.floor(floor) + 600_000);
    expect(expiresAt).toBeLessThanOrEqual(ceiling + 600_000);
    // The listing judges expiry on the same clock.
    const [active] = (await store.listActiveExecutions("local_docker")).filter(
      (e) => e.executionId === intent.executionId,
    );
    expect(active?.nonceExpired).toBe(false);
  });
});
