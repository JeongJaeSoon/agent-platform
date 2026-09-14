import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  claim,
  createApiKey,
  findApiKeyOwner,
  findOrphanedSessions,
  getSessionForOwner,
  release,
  requeueOrphan,
  transitionSession,
} from "./queries.ts";
import * as schema from "./schema.ts";
import {
  apiKeys,
  queueMessages,
  sessions,
  unassignedSessions,
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

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
});

afterEach(async () => {
  await client.close();
});

describe("session queries", () => {
  test("allows exactly one concurrent claim and removes its signal", async () => {
    const sessionId = await insertSession();
    await db.insert(unassignedSessions).values({ sessionId });
    const results = await Promise.all([
      claim(db, sessionId, "pod-a"),
      claim(db, sessionId, "pod-b"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(await db.select().from(unassignedSessions)).toHaveLength(0);
  });

  test("releases only the current owner's mapping", async () => {
    const sessionId = await insertSession({
      podId: "pod-a",
      status: "running",
    });
    expect(await release(db, sessionId, "pod-b")).toBeNull();
    expect((await getSessionForOwner(db, sessionId, "owner-a"))?.podId).toBe(
      "pod-a",
    );
    expect(await release(db, sessionId, "pod-a")).not.toBeNull();
  });

  test("signals a released session that still has pending messages", async () => {
    const sessionId = await insertSession({
      podId: "pod-a",
      status: "idle",
    });
    await db.insert(queueMessages).values({
      sessionId,
      kind: "message",
      payload: { message: "arrived during release" },
    });

    expect(await release(db, sessionId, "pod-a")).not.toBeNull();
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(1);
  });

  test("enforces documented status transitions", async () => {
    const sessionId = await insertSession();
    expect(
      await transitionSession(db, sessionId, "queued", "running"),
    ).not.toBeNull();
    expect(
      await transitionSession(db, sessionId, "running", "needs_input"),
    ).not.toBeNull();
    expect(
      await transitionSession(db, sessionId, "needs_input", "running"),
    ).not.toBeNull();
    expect(
      await transitionSession(db, sessionId, "running", "stopped"),
    ).not.toBeNull();
    expect(() =>
      transitionSession(db, sessionId, "stopped", "running"),
    ).toThrow("Invalid session status transition");
  });

  test("never returns another owner's session", async () => {
    const sessionId = await insertSession();
    expect(await getSessionForOwner(db, sessionId, "owner-b")).toBeNull();
    expect(await getSessionForOwner(db, sessionId, "owner-a")).not.toBeNull();
  });

  test("finds only sessions with expired or missing worker leases", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    await db.insert(workers).values([
      { podId: "fresh", lastSeen: new Date(now.getTime() - 500) },
      { podId: "stale", lastSeen: new Date(now.getTime() - 2_000) },
    ]);
    const fresh = await insertSession({ podId: "fresh", status: "running" });
    const stale = await insertSession({ podId: "stale", status: "running" });
    const missing = await insertSession({
      podId: "missing",
      status: "running",
    });
    await insertSession({ status: "queued" });
    const ids = (await findOrphanedSessions(db, 1_000, now)).map(
      ({ id }) => id,
    );
    expect(ids).toContain(stale);
    expect(ids).toContain(missing);
    expect(ids).not.toContain(fresh);
  });

  test("requeues an orphan atomically after clearing its mapping", async () => {
    const sessionId = await insertSession({
      podId: "stale",
      status: "running",
    });
    expect(await requeueOrphan(db, sessionId, "wrong")).toBe(false);
    expect(await requeueOrphan(db, sessionId, "stale")).toBe(true);
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "queued")));
    expect(session?.podId).toBeNull();
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(1);
  });
});

describe("API key queries", () => {
  test("stores only the digest and resolves one active owner", async () => {
    const plaintext = "csp_plaintext_is_never_stored";
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(plaintext),
      ),
    );
    await createApiKey(db, {
      id: crypto.randomUUID(),
      ownerId: "owner-a",
      keyHash: digest,
    });

    const [stored] = await db.select().from(apiKeys);
    expect(stored?.keyHash).toEqual(digest);
    expect(new TextDecoder().decode(stored?.keyHash)).not.toContain(plaintext);
    expect(await findApiKeyOwner(db, digest)).toBe("owner-a");
    expect(await findApiKeyOwner(db, new Uint8Array(32))).toBeNull();
  });

  test("does not resolve revoked keys", async () => {
    const digest = new Uint8Array(32).fill(7);
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      ownerId: "owner-a",
      keyHash: digest,
      revokedAt: new Date(),
    });
    expect(await findApiKeyOwner(db, digest)).toBeNull();
  });
});
