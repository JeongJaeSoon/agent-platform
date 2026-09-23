import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { and, eq, isNotNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresCheckpointStore } from "./checkpoint-store.ts";
import * as schema from "./schema.ts";
import { attempts, checkpoints, sessions } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * 94S-281: what checkpoint garbage collection reads from and writes to
 * PostgreSQL — which attempts can never commit again, and which rows it
 * retires before deleting their objects.
 */
integration("checkpoint collection store on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "ckpt_gc_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function session(fields: Partial<typeof sessions.$inferInsert> = {}) {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      branch: `session/${id}`,
      id,
      ownerId: "owner-gc",
      repoUrl: "https://example.invalid/app.git",
      authRevision: 1,
      executionGeneration: 2,
      leaseEpoch: 3,
      ...fields,
    });
    return id;
  }

  async function attempt(
    sessionId: string,
    fields: Partial<typeof attempts.$inferInsert> = {},
  ) {
    const id = `attempt-${crypto.randomUUID()}`;
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: 2,
      executionId: `exec-${id}`,
      id,
      leaseEpoch: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      sessionId,
      state: "running",
      ...fields,
    });
    return id;
  }

  test("an attempt is fenced once it ended or the session's epoch, generation or auth revision moved past it", async () => {
    const sessionId = await session({ checkpointFallbackRevision: 4 });
    const live = await attempt(sessionId);
    const expired = await attempt(sessionId, {
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const exited = await attempt(sessionId, { state: "exited" });
    const lost = await attempt(sessionId, { state: "lost" });
    const oldEpoch = await attempt(sessionId, { leaseEpoch: 2 });
    const oldGeneration = await attempt(sessionId, { executionGeneration: 1 });
    const oldAuth = await attempt(sessionId, { authRevision: 0 });
    const store = createPostgresCheckpointStore(db);

    const fences = await store.readCollectionFences(sessionId);

    expect(fences?.fallbackRevision).toBe(4);
    expect([...(fences?.fencedAttemptIds ?? [])].sort()).toEqual(
      [exited, lost, oldEpoch, oldGeneration, oldAuth].sort(),
    );
    expect(fences?.fencedAttemptIds.has(live)).toBe(false);
    // A lapsed lease is the reconciler's to judge; until then it may renew.
    expect(fences?.fencedAttemptIds.has(expired)).toBe(false);
    expect(await store.readCollectionFences(crypto.randomUUID())).toBeNull();
  });

  test("markCollected retires the rows up to the pointer that are not kept, once", async () => {
    const sessionId = await session({ checkpointRevision: 3 });
    for (const revision of [0, 1, 2, 3]) {
      await db.insert(checkpoints).values({
        manifestRef: `sessions/${sessionId}/checkpoints/${revision}/manifest.json`,
        manifestSha256: "a".repeat(64),
        revision,
        sessionId,
      });
    }
    const store = createPostgresCheckpointStore(db);

    expect(
      await store.markCollected(sessionId, {
        keep: [3, 2],
        throughRevision: 3,
      }),
    ).toBe(2);
    expect(
      await store.markCollected(sessionId, { keep: [3], throughRevision: 3 }),
    ).toBe(1);
    expect(
      await store.markCollected(sessionId, { keep: [], throughRevision: 1 }),
    ).toBe(0);

    const marked = await db
      .select({ revision: checkpoints.revision })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.sessionId, sessionId),
          isNotNull(checkpoints.collectedAt),
        ),
      );
    expect(marked.map((row) => row.revision).sort()).toEqual([0, 1, 2]);
  });

  test("listSessionIds pages through every session in id order", async () => {
    const store = createPostgresCheckpointStore(db);
    const all = (await db.select({ id: sessions.id }).from(sessions))
      .map((row) => row.id)
      .sort();

    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: string[] = await store.listSessionIds({ after, limit: 2 });
      seen.push(...page);
      if (page.length < 2) break;
      after = page.at(-1) ?? null;
    }

    expect(seen).toEqual(all);
  });
});
