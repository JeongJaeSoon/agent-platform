import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import {
  queueMessages,
  sessions,
  unassignedSessions,
} from "@agent-platform/db";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { PostgresQueue } from "./postgres.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// A legacy pod giving its session up: pod_id cleared, then the session
// re-signalled if input is already waiting. What enqueue has to race without
// losing the signal.
async function release(
  db: NodePgDatabase<typeof schema>,
  sessionId: string,
  podId: string,
) {
  await db.transaction(async (tx) => {
    const [released] = await tx
      .update(sessions)
      .set({ podId: null })
      .where(and(eq(sessions.id, sessionId), eq(sessions.podId, podId)))
      .returning({ id: sessions.id });
    if (!released) return;
    const [pending] = await tx
      .select({ id: queueMessages.id })
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, sessionId))
      .limit(1);
    if (pending) {
      await tx
        .insert(unassignedSessions)
        .values({ sessionId })
        .onConflictDoNothing({ target: unassignedSessions.sessionId });
    }
  });
}

integration("PostgresQueue on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let queue: PostgresQueue;
  let sessionId: string;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "queue_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    queue = new PostgresQueue(db);
    sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "integration-owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      await database.drop();
    }
  }, 60_000);

  test("uses concurrent SKIP LOCKED claims without duplicates", async () => {
    for (let sequence = 0; sequence < 10; sequence += 1) {
      await queue.enqueue({ sessionId, payload: { message: `${sequence}` } });
    }
    const deliveries = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        queue.consume(sessionId, `postgres-consumer-${index}`),
      ),
    );
    expect(deliveries.filter(Boolean)).toHaveLength(10);
    expect(new Set(deliveries.map((delivery) => delivery?.id)).size).toBe(10);
    await Promise.all(
      deliveries.map((delivery) => delivery?.ack() ?? Promise.resolve()),
    );
  });

  test("stores an event before notifying and replays it later", async () => {
    const published = await queue.publish({
      sessionId,
      event: "status",
      data: { phase: "running" },
    });
    const controller = new AbortController();
    for await (const event of queue.subscribe({
      sessionId,
      signal: controller.signal,
      pollIntervalMs: 1,
    })) {
      expect(event).toEqual(published);
      controller.abort();
    }
  });

  test("publish waits for the session row lock, so ids follow commit order", async () => {
    // A writer holding the session row must block publish until it commits:
    // that is what keeps a lower events.id from committing after a higher one
    // and lets the SSE reader resume from the last id it saw.
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
      sessionId,
    ]);
    let published = false;
    const publishing = queue
      .publish({ sessionId, event: "status", data: { phase: "running" } })
      .then((event) => {
        published = true;
        return event;
      });
    await Bun.sleep(200);
    expect(published).toBe(false);
    await holder.query("COMMIT");
    holder.release();
    const event = await publishing;
    expect(published).toBe(true);
    expect(event.id).toStartWith("ev_");
  }, 10_000);

  test("never loses the unassigned signal when enqueue races with release", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await db
        .update(sessions)
        .set({ podId: "integration-pod", status: "idle" })
        .where(eq(sessions.id, sessionId));
      await db
        .delete(queueMessages)
        .where(eq(queueMessages.sessionId, sessionId));
      await db
        .delete(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId));

      await Promise.all([
        queue.enqueue({ sessionId, payload: { message: `race-${attempt}` } }),
        release(db, sessionId, "integration-pod"),
      ]);

      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, sessionId)),
      ).toHaveLength(1);
    }
  });
});
