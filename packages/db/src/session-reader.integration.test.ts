import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, MemoryLogSink } from "@agent-platform/observability";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { events, executions, sessions, turns } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-reader";

integration("session reader on PostgreSQL (94S-396)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const sink = new MemoryLogSink();
  const logger = createLogger({ sinks: [sink] });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_reader_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function queuedSession() {
    const [session] = await db
      .insert(sessions)
      .values({
        id: crypto.randomUUID(),
        ownerId: OWNER,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("no session");
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId: session.id,
        sequence: 1,
        message: "hello",
        status: "queued",
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    return { sessionId: session.id, turnId: turn.id };
  }

  test("a pending reason this build does not know reads as unknown and still holds input back", async () => {
    const { sessionId } = await queuedSession();
    await db
      .update(sessions)
      .set({ checkpointPendingReason: "future_reason" })
      .where(eq(sessions.id, sessionId));

    const detail = await createPostgresSessionReader(db, {
      logger,
    }).getSession(OWNER, sessionId);
    expect(detail?.durability.checkpoint_pending_reason).toBe("unknown");
    expect(
      sink.records.map(({ level, message, fields }) => ({
        level,
        message,
        fields,
      })),
    ).toEqual([
      {
        level: "warn",
        message: "Stored checkpoint pending reason is unknown",
        fields: {
          session_id: sessionId,
          checkpoint_pending_reason: "future_reason",
        },
      },
    ]);

    const appended = await createPostgresSessionUnitOfWork(
      db,
    ).appendInputAtomic({
      principal: { ownerId: OWNER },
      sessionId,
      idempotencyKey: "future-reason-append",
      payloadHash: "hash",
      message: "more",
      limits: {
        queuedInputLimitPerSession: 100,
        storageLimitBytes: 1e15,
      },
    });
    expect(appended).toEqual({
      outcome: "checkpoint_unavailable",
      reason: "future_reason",
    });
  });

  test("last_event_at is the time of the newest event in stream order, in list and detail", async () => {
    const { sessionId } = await queuedSession();
    const reader = createPostgresSessionReader(db);
    expect((await reader.getSession(OWNER, sessionId))?.last_event_at).toBe(
      null,
    );
    // The later row carries the earlier time, as a transaction that
    // started first but took the session lock second would write it.
    const at = new Date("2026-09-26T01:02:03.456Z");
    await db.insert(events).values([
      {
        sessionId,
        type: "status",
        payload: {},
        createdAt: new Date(at.getTime() + 60_000),
      },
      { sessionId, type: "status", payload: {}, createdAt: at },
    ]);
    expect((await reader.getSession(OWNER, sessionId))?.last_event_at).toBe(
      at.toISOString(),
    );
    const listed = await reader.listSessions(OWNER, { limit: 100 });
    expect(
      listed.items.find((item) => item.id === sessionId)?.last_event_at,
    ).toBe(at.toISOString());
  });

  test("a detail read in a caller's read committed transaction is refused", async () => {
    const { sessionId } = await queuedSession();
    await db.transaction(async (tx) => {
      await expect(
        createPostgresSessionReader(tx).getSession(OWNER, sessionId),
      ).rejects.toThrow("Session detail needs a snapshot transaction");
    });
  });

  test("every detail field comes from one snapshot", async () => {
    const { sessionId, turnId } = await queuedSession();
    const reader = createPostgresSessionReader(db);
    const before = await reader.getSession(OWNER, sessionId);
    expect(before?.execution).toBeNull();
    expect(before?.durability.last_completed_turn_id).toBeNull();

    // The writer holds executions so the detail stops on it after its
    // first reads, then changes what the reads after it would see.
    const writer = await pool.connect();
    let committed = false;
    try {
      await writer.query("BEGIN");
      await writer.query("LOCK TABLE executions IN ACCESS EXCLUSIVE MODE");
      const during = reader.getSession(OWNER, sessionId);
      await waitForLockWait(pool, "executions");
      await writer.query(
        "UPDATE turns SET status = 'completed', started_at = now(), ended_at = now() WHERE id = $1",
        [turnId],
      );
      await writer.query(
        `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
         VALUES ($1, $2, 'local_docker', 1, 'running', 'running')`,
        [`exec-${sessionId}`, sessionId],
      );
      await writer.query("COMMIT");
      committed = true;
      expect(await during).toEqual(before);
    } finally {
      if (!committed) await writer.query("ROLLBACK");
      writer.release();
    }

    const after = await reader.getSession(OWNER, sessionId);
    expect(after?.execution?.state).toBe("running");
    expect(after?.durability.last_completed_turn_id).toBe("1");
    expect(
      await db
        .select({ id: executions.id })
        .from(executions)
        .where(eq(executions.sessionId, sessionId)),
    ).toHaveLength(1);
  });
});

async function waitForLockWait(pool: Pool, table: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      "SELECT 1 FROM pg_locks WHERE relation = $1::regclass AND NOT granted",
      [table],
    );
    if (rows.length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error(`nothing waited on ${table}`);
}
