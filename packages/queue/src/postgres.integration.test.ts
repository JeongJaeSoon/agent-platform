import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@claude-session-platform/db";
import {
  events,
  queueMessages,
  release,
  sessions,
  unassignedSessions,
} from "@claude-session-platform/db";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { PostgresQueue } from "./postgres.ts";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgresQueue on PostgreSQL", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let queue: PostgresQueue;
  let sessionId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    db = drizzle(pool, { schema });
    const schemaState = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (schemaState.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../../db/migrations`,
      });
    }
    queue = new PostgresQueue(db);
    sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "integration-owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
  });

  afterAll(async () => {
    await db.delete(events).where(eq(events.sessionId, sessionId));
    await db
      .delete(queueMessages)
      .where(eq(queueMessages.sessionId, sessionId));
    await db
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await pool.end();
  });

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
      data: { status: "running" },
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
