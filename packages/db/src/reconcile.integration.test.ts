import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { claim, reconcileOrphanedSessions } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  queueMessages,
  sessions,
  turns,
  unassignedSessions,
  workers,
} from "./schema.ts";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("orphan reconciliation on PostgreSQL", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const sessionIds: string[] = [];
  const podIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    db = drizzle(pool, { schema });
    const schemaState = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (schemaState.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../migrations`,
      });
    }
  });

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await db
        .delete(unassignedSessions)
        .where(inArray(unassignedSessions.sessionId, sessionIds));
      await db
        .delete(queueMessages)
        .where(inArray(queueMessages.sessionId, sessionIds));
      await db.delete(turns).where(inArray(turns.sessionId, sessionIds));
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
    }
    if (podIds.length > 0) {
      await db.delete(workers).where(inArray(workers.podId, podIds));
    }
    sessionIds.length = 0;
    podIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedOrphan(now: Date) {
    const sessionId = crypto.randomUUID();
    const podId = `orphan-${crypto.randomUUID()}`;
    sessionIds.push(sessionId);
    podIds.push(podId);
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "reconcile-integration",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
      podId,
      status: "running",
    });
    await db.insert(workers).values({
      podId,
      lastSeen: new Date(now.getTime() - 60_000),
    });
    const [turn] = await db
      .insert(turns)
      .values({ sessionId, message: "retry original row", status: "queued" })
      .returning({ id: turns.id });
    const [message] = await db
      .insert(queueMessages)
      .values({
        sessionId,
        turnId: turn?.id,
        kind: "message",
        payload: { message: "retry original row" },
        claimedBy: podId,
        claimToken: crypto.randomUUID(),
        visibleAt: new Date(now.getTime() + 60_000),
      })
      .returning({ id: queueMessages.id });
    if (!message) throw new Error("Failed to seed queue message");
    if (!turn) throw new Error("Failed to seed turn");
    return { messageId: message.id, podId, sessionId, turnId: turn.id };
  }

  test("two reconcilers recover one orphan exactly once", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    const results = await Promise.all([
      reconcileOrphanedSessions(db, { leaseTtlMs: 1_000, now }),
      reconcileOrphanedSessions(db, { leaseTtlMs: 1_000, now }),
    ]);

    expect(results.flat()).toEqual([
      expect.objectContaining({
        releasedMessageIds: [seeded.messageId],
        sessionId: seeded.sessionId,
      }),
    ]);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, seeded.sessionId)),
    ).toHaveLength(1);
  });

  test("preserves an in-flight row without signaling automatic replay", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    await db
      .update(turns)
      .set({ status: "running" })
      .where(eq(turns.id, seeded.turnId));

    expect(
      await reconcileOrphanedSessions(db, { leaseTtlMs: 1_000, now }),
    ).toEqual([
      expect.objectContaining({
        action: "blocked",
        blockedMessageIds: [seeded.messageId],
        releasedMessageIds: [],
        sessionId: seeded.sessionId,
      }),
    ]);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, seeded.sessionId));
    expect(session).toMatchObject({ podId: null, status: "failed" });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, seeded.sessionId)),
    ).toHaveLength(0);
    const [message] = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.id, seeded.messageId));
    expect(message).toMatchObject({
      claimedBy: seeded.podId,
      id: seeded.messageId,
    });
  });

  test("rechecks a heartbeat that refreshes after candidate discovery", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE workers SET last_seen = $1 WHERE pod_id = $2",
        [now, seeded.podId],
      );
      const reconciliation = reconcileOrphanedSessions(db, {
        leaseTtlMs: 1_000,
        now,
      });
      await Bun.sleep(20);
      await client.query("COMMIT");

      expect(await reconciliation).toEqual([]);
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, seeded.sessionId));
      expect(session).toMatchObject({
        podId: seeded.podId,
        status: "running",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  test("a new claimant takes the released session without a duplicate signal", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const seeded = await seedOrphan(now);
    const newPodId = `new-${crypto.randomUUID()}`;
    const reconciliation = reconcileOrphanedSessions(db, {
      leaseTtlMs: 1_000,
      now,
    });
    const claimed = (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await claim(db, seeded.sessionId, newPodId);
        if (result) return result;
        await Bun.sleep(1);
      }
      throw new Error("New worker did not claim the reconciled session");
    })();

    expect(await reconciliation).toHaveLength(1);
    expect(await claimed).toMatchObject({
      id: seeded.sessionId,
      podId: newPodId,
      status: "running",
    });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, seeded.sessionId)),
    ).toHaveLength(0);
    const [message] = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.id, seeded.messageId));
    expect(message).toMatchObject({
      id: seeded.messageId,
      claimedBy: null,
      claimToken: null,
    });
  });
});
