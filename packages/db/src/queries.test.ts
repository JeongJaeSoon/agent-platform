import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  createApiKey,
  findApiKey,
  reconcileOrphanedSessions,
} from "./queries.ts";
import * as schema from "./schema.ts";
import {
  apiKeys,
  executions,
  queueMessages,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
  workers,
} from "./schema.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

async function insertSession(
  overrides: Partial<typeof sessions.$inferInsert> = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    ownerId: "owner-a",
    repoUrl: "https://example.invalid/repo.git",
    branch: `session/${id}`,
    ...overrides,
  });
  return id;
}

async function sessionOf(sessionId: string) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return session;
}

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
});

afterEach(async () => {
  await client.close();
});

describe("session queries", () => {
  test("without a pinned now, deadlines are judged on the database clock", async () => {
    // The process clock is irrelevant: these deadlines are relative to the
    // database's own now, which is what the heartbeat writer used.
    const [row] = await db
      .select({ at: sql<string>`clock_timestamp()::text` })
      .from(sql`(select 1) as one`);
    const dbNow = new Date(row?.at ?? "");
    await db.insert(workers).values([
      {
        podId: "db-live",
        lastSeen: dbNow,
        leaseExpiresAt: new Date(dbNow.getTime() + 600_000),
      },
      {
        podId: "db-expired",
        lastSeen: new Date(dbNow.getTime() - 600_000),
        leaseExpiresAt: new Date(dbNow.getTime() - 60_000),
      },
    ]);
    const live = await insertSession({ podId: "db-live", status: "running" });
    const expired = await insertSession({
      podId: "db-expired",
      status: "running",
    });
    const reconciled = await reconcileOrphanedSessions(db, { dryRun: true });
    expect(reconciled.map(({ sessionId }) => sessionId)).toContain(expired);
    expect(reconciled.map(({ sessionId }) => sessionId)).not.toContain(live);
  });

  test("reconciles a stale owner by releasing the original queue row", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const sessionId = await insertSession({
      podId: "stale-owner",
      status: "running",
    });
    await db.insert(workers).values({
      podId: "stale-owner",
      lastSeen: new Date(now.getTime() - 2_000),
      leaseExpiresAt: new Date(now.getTime() - 2_000 + 1_000),
    });
    const [turn] = await db
      .insert(turns)
      .values({ sessionId, sequence: 1, message: "retry me", status: "queued" })
      .returning({ id: turns.id });
    const [message] = await db
      .insert(queueMessages)
      .values({
        sessionId,
        turnId: turn?.id,
        kind: "message",
        payload: { message: "retry me" },
        claimedBy: "stale-owner",
        claimToken: crypto.randomUUID(),
        visibleAt: new Date(now.getTime() + 60_000),
      })
      .returning({ id: queueMessages.id });

    expect(
      await reconcileOrphanedSessions(db, {
        now,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "requeued",
        releasedMessageIds: [message?.id],
        sessionId,
        stalePodId: "stale-owner",
      }),
    ]);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const [released] = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.id, message?.id ?? -1));
    expect(session).toMatchObject({ podId: null, status: "queued" });
    expect(released).toMatchObject({
      id: message?.id,
      claimedBy: null,
      claimToken: null,
      visibleAt: now,
    });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(1);
  });

  test("requeues an orphan into the session's partition, whatever launch history says", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const partition = `p-${crypto.randomUUID()}`;
    const sessionId = await insertSession({
      partition,
      podId: "stale-owner",
      status: "running",
    });
    await db.insert(executions).values({
      backend: "local_docker",
      desiredState: "running",
      generation: 1,
      id: "exec-earlier",
      observedState: "running",
      sessionId,
    });
    await db.insert(workerLaunches).values({
      backend: "local_docker",
      executionId: "exec-earlier",
      generation: 1,
      partition: `other-${crypto.randomUUID()}`,
      sessionId,
    });
    await db.insert(turns).values({
      message: "retry me",
      sequence: 1,
      sessionId,
      status: "queued",
    });
    await db.insert(queueMessages).values({
      kind: "message",
      payload: { message: "retry me" },
      sessionId,
    });

    expect(await reconcileOrphanedSessions(db, { now })).toEqual([
      expect.objectContaining({ action: "requeued", sessionId }),
    ]);
    expect(
      await db
        .select({ partition: unassignedSessions.partition })
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toEqual([{ partition }]);
  });

  test("does not signal an empty orphan or touch a fresh lease", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const emptyId = await insertSession({
      podId: "missing-owner",
      status: "running",
    });
    const freshId = await insertSession({
      podId: "fresh-owner",
      status: "running",
    });
    await db.insert(workers).values({
      podId: "fresh-owner",
      lastSeen: new Date(now.getTime() - 100),
      leaseExpiresAt: new Date(now.getTime() - 100 + 1_000),
    });

    expect(
      await reconcileOrphanedSessions(db, {
        now,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "released",
        sessionId: emptyId,
      }),
    ]);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, emptyId)),
    ).toHaveLength(0);
    expect(await sessionOf(emptyId)).toMatchObject({
      podId: null,
      status: "failed",
    });
    expect(await sessionOf(freshId)).toMatchObject({
      podId: "fresh-owner",
      status: "running",
    });
  });

  test("acks terminal queue rows instead of replaying them", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const sessionId = await insertSession({
      podId: "terminal-owner",
      status: "running",
    });
    const [turn] = await db
      .insert(turns)
      .values({ sessionId, sequence: 1, message: "done", status: "completed" })
      .returning({ id: turns.id });
    const [message] = await db
      .insert(queueMessages)
      .values({
        sessionId,
        turnId: turn?.id,
        kind: "message",
        payload: { message: "already completed" },
        claimedBy: "terminal-owner",
        claimToken: crypto.randomUUID(),
      })
      .returning({ id: queueMessages.id });

    expect(
      await reconcileOrphanedSessions(db, {
        now,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "released",
        releasedMessageIds: [],
        terminalMessageIds: [message?.id],
      }),
    ]);
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, sessionId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(0);
  });

  test("acks completed and interrupted rows without replaying them", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const sessionId = await insertSession({
      podId: "mixed-owner",
      status: "running",
    });
    const createdTurns = await db
      .insert(turns)
      .values([
        { sessionId, sequence: 1, message: "checkpoint", status: "completed" },
        { sessionId, sequence: 2, message: "stopped", status: "interrupted" },
      ])
      .returning({ id: turns.id, status: turns.status });
    const checkpointTurn = createdTurns.find(
      ({ status }) => status === "completed",
    );
    const interruptedTurn = createdTurns.find(
      ({ status }) => status === "interrupted",
    );
    if (!checkpointTurn || !interruptedTurn) {
      throw new Error("Failed to seed recovery turns");
    }
    const messages = await db
      .insert(queueMessages)
      .values([
        {
          sessionId,
          turnId: checkpointTurn.id,
          kind: "message",
          payload: { message: "checkpoint" },
          claimedBy: "mixed-owner",
          claimToken: crypto.randomUUID(),
        },
        {
          sessionId,
          turnId: interruptedTurn.id,
          kind: "message",
          payload: { message: "stopped" },
          claimedBy: "mixed-owner",
          claimToken: crypto.randomUUID(),
        },
      ])
      .returning({ id: queueMessages.id, turnId: queueMessages.turnId });
    const checkpointMessage = messages.find(
      ({ turnId }) => turnId === checkpointTurn.id,
    );
    const interruptedMessage = messages.find(
      ({ turnId }) => turnId === interruptedTurn.id,
    );
    if (!checkpointMessage || !interruptedMessage) {
      throw new Error("Failed to seed recovery messages");
    }

    expect(
      await reconcileOrphanedSessions(db, {
        now,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "released",
        releasedMessageIds: [],
        terminalMessageIds: [checkpointMessage.id, interruptedMessage.id],
      }),
    ]);
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, sessionId)),
    ).toHaveLength(0);
  });

  test("blocks replay when in-flight side effects are not proven safe", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const sessionId = await insertSession({
      podId: "unsafe-owner",
      status: "running",
    });
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence: 1,
        message: "in flight",
        status: "running",
      })
      .returning({ id: turns.id });
    const messages = await db
      .insert(queueMessages)
      .values([
        {
          sessionId,
          turnId: turn?.id,
          kind: "message",
          payload: { message: "running" },
          claimedBy: "unsafe-owner",
          claimToken: crypto.randomUUID(),
        },
        {
          sessionId,
          kind: "message",
          payload: { message: "unknown execution state" },
          claimedBy: "unsafe-owner",
          claimToken: crypto.randomUUID(),
        },
      ])
      .returning({ id: queueMessages.id });

    expect(
      await reconcileOrphanedSessions(db, {
        now,
      }),
    ).toEqual([
      expect.objectContaining({
        action: "blocked",
        blockedMessageIds: messages.map(({ id }) => id),
        releasedMessageIds: [],
        terminalMessageIds: [],
      }),
    ]);
    expect(await sessionOf(sessionId)).toMatchObject({
      podId: null,
      status: "failed",
    });
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, sessionId)),
    ).toHaveLength(2);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(0);
  });

  test("supports dry-run and concurrent reconcilers without duplicate work", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    const sessionId = await insertSession({
      podId: "concurrent-owner",
      status: "running",
    });
    await db.insert(queueMessages).values({
      sessionId,
      kind: "message",
      payload: { message: "once" },
    });
    const dryRun = await reconcileOrphanedSessions(db, {
      dryRun: true,
      now,
    });
    expect(dryRun).toEqual([
      expect.objectContaining({ dryRun: true, sessionId }),
    ]);
    expect(await sessionOf(sessionId)).toMatchObject({
      podId: "concurrent-owner",
      status: "running",
    });

    const results = await Promise.all([
      reconcileOrphanedSessions(db, { now }),
      reconcileOrphanedSessions(db, { now }),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(1);
  });
});

describe("API key queries", () => {
  test("stores only the digest and resolves one active key with its scopes", async () => {
    const plaintext = "csp_plaintext_is_never_stored";
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(plaintext),
      ),
    );
    const id = crypto.randomUUID();
    await createApiKey(db, {
      id,
      ownerId: "owner-a",
      keyHash: digest,
      scopes: ["sessions:read", "sessions:write"],
    });

    const [stored] = await db.select().from(apiKeys);
    expect(stored?.keyHash).toEqual(digest);
    expect(new TextDecoder().decode(stored?.keyHash)).not.toContain(plaintext);
    expect(stored?.scopes).toEqual(["sessions:read", "sessions:write"]);
    expect(await findApiKey(db, digest)).toEqual({
      id,
      ownerId: "owner-a",
      workspaceId: null,
      scopes: ["sessions:read", "sessions:write"],
    });
    expect(await findApiKey(db, new Uint8Array(32))).toBeNull();
  });

  test("a key issued before scopes resolves with null scopes", async () => {
    const digest = new Uint8Array(32).fill(3);
    await createApiKey(db, {
      id: crypto.randomUUID(),
      ownerId: "owner-a",
      keyHash: digest,
      scopes: null,
    });
    expect((await findApiKey(db, digest))?.scopes).toBeNull();
  });

  test("the scope CHECK refuses a word outside the vocabulary", async () => {
    expect(
      createApiKey(db, {
        id: crypto.randomUUID(),
        ownerId: "owner-a",
        keyHash: new Uint8Array(32).fill(4),
        scopes: ["sessions:admin" as "sessions:read"],
      }),
    ).rejects.toThrow();
  });

  test("does not resolve revoked keys", async () => {
    const digest = new Uint8Array(32).fill(7);
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      ownerId: "owner-a",
      keyHash: digest,
      revokedAt: new Date(),
    });
    expect(await findApiKey(db, digest)).toBeNull();
  });
});
