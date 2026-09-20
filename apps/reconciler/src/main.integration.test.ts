import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import {
  queueMessages,
  sessions,
  turns,
  unassignedSessions,
  workers,
} from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("reconciler process on PostgreSQL", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const sessionId = crypto.randomUUID();
  const podId = `reconciler-${crypto.randomUUID()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    const schemaState = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (schemaState.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../../../packages/db/migrations`,
      });
    }
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "reconciler-owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
      podId,
      status: "running",
    });
    await db.insert(workers).values({
      podId,
      lastSeen: new Date(Date.now() - 60_000),
    });
    const [turn] = await db
      .insert(turns)
      .values({ sessionId, message: "resume after crash", status: "queued" })
      .returning({ id: turns.id });
    await db.insert(queueMessages).values({
      sessionId,
      turnId: turn?.id,
      kind: "message",
      payload: { message: "resume after crash" },
      claimedBy: podId,
      claimToken: crypto.randomUUID(),
      visibleAt: new Date(Date.now() + 60_000),
    });
  });

  afterAll(async () => {
    await db
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, sessionId));
    await db
      .delete(queueMessages)
      .where(eq(queueMessages.sessionId, sessionId));
    await db.delete(turns).where(eq(turns.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db.delete(workers).where(eq(workers.podId, podId));
    await pool.end();
  });

  test("requeues once, logs the session, and exits zero", async () => {
    const child = Bun.spawn(
      [process.execPath, "run", `${import.meta.dir}/main.ts`],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          HEARTBEAT_TTL_SEC: "1",
          RECONCILER_BATCH_SIZE: "10",
          RECONCILER_DRY_RUN: "false",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(5_000).then(() => {
        child.kill();
        throw new Error("Reconciler process did not exit");
      }),
    ]);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("Orphan session reconciliation completed");
    expect(stdout).toContain(sessionId);
    expect(stdout).toContain('"reconciled_count":1');
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session).toMatchObject({ podId: null, status: "queued" });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(1);
  });
});
