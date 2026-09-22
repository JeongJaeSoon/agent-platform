import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTempDatabase, type TempDatabase } from "@agent-platform/testkit";
import { eq } from "drizzle-orm";
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

  /** One reserved launch with a credential issued, ready to be replaced. */
  async function reservedLaunch() {
    const store = createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
    });
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "race",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
    await db.insert(unassignedSessions).values({ sessionId });
    const intent = await store.reserveLaunch({
      backend: "local_docker",
      now: new Date(),
      sessionId,
      // The reservation test above leaves its ten launches holding slots.
      slotLimit: 100,
    });
    if (!intent) throw new Error("no intent");
    await store.issueBootstrapNonce(intent, new Date());
    return { intent, sessionId, store };
  }

  /** Resolves to "pending" if `promise` has not settled within `ms`. */
  function settledWithin<T>(promise: Promise<T>, ms: number) {
    return Promise.race([
      promise.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), ms),
      ),
    ]);
  }

  test("a replacement request waits behind an exit confirmation holding the row and then loses to it", async () => {
    const { intent, store } = await reservedLaunch();
    // An exit confirmation in flight: it has the launch row locked and has
    // released the slot, but has not committed.
    const confirming = await pool.connect();
    try {
      await confirming.query("BEGIN");
      await confirming.query(
        "UPDATE worker_launches SET slot_released_at = now() WHERE execution_id = $1",
        [intent.executionId],
      );
      const request = store.requestReplacement(
        intent,
        "stale_isolation",
        new Date(),
      );
      expect(await settledWithin(request, 300)).toBe("pending");
      await confirming.query("COMMIT");
      // The request re-reads the row once it gets the lock: no slot, no
      // rebuild, and nothing for the scheduler to tear down.
      expect(await request).toBeNull();
    } finally {
      confirming.release();
    }
    const [row] = await db
      .select({ reason: workerLaunches.replacementReason })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(row?.reason).toBeNull();
  }, 60_000);

  test("an exit confirmation waits behind a replacement request holding the row and then refuses", async () => {
    const { intent, sessionId, store } = await reservedLaunch();
    // A replacement request in flight: reason written, not committed.
    const requesting = await pool.connect();
    try {
      await requesting.query("BEGIN");
      await requesting.query(
        "UPDATE worker_launches SET replacement_reason = 'stale_isolation', replacement_count = 1, nonce_hash = NULL WHERE execution_id = $1",
        [intent.executionId],
      );
      const confirm = store.confirmExecutionGone(
        intent.executionId,
        new Date(),
      );
      expect(await settledWithin(confirm, 300)).toBe("pending");
      await requesting.query("COMMIT");
      await confirm;
    } finally {
      requesting.release();
    }
    // The plan committed first, so the confirmation changed nothing: the
    // launch still holds its slot and the session is still bound to it.
    const [launch] = await db
      .select({ slotReleasedAt: workerLaunches.slotReleasedAt })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(launch?.slotReleasedAt).toBeNull();
    const [session] = await db
      .select({ executionId: sessions.executionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.executionId).toBe(intent.executionId);
  }, 60_000);
});
