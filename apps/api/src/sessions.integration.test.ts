import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
} from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  idempotencyKeys,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "@agent-platform/db";
import {
  createSessionService,
  ownerScopedPolicy,
} from "@agent-platform/platform";
import { count, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("sessions API on PostgreSQL", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  const owner = `owner-${crypto.randomUUID()}`;
  const stranger = `owner-${crypto.randomUUID()}`;
  const body = {
    profile_id: "claude-coding-v1",
    repository_id: "sample-app",
    message: "Inspect the failing unit test and propose a fix.",
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 12 });
    db = drizzle(pool, { schema });
    const state = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (state.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../../../packages/db/migrations`,
      });
    }
    const service = createSessionService({
      authorization: ownerScopedPolicy,
      inputs: createPostgresSessionUnitOfWork(db),
      reader: createPostgresSessionReader(db),
      catalog: {
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
          },
        },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
          },
        },
      },
    });
    app = createApiApp({
      authMode: "none",
      registerRoutes: (router) => registerSessionRoutes(router, service),
    });
  });

  afterAll(async () => {
    for (const ownerId of [owner, stranger]) {
      const owned = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.ownerId, ownerId));
      for (const { id } of owned) {
        await db.delete(queueMessages).where(eq(queueMessages.sessionId, id));
        await db
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, id));
        await db.delete(turns).where(eq(turns.sessionId, id));
      }
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.principal, ownerId));
      await db.delete(receipts).where(eq(receipts.ownerId, ownerId));
      await db.delete(sessions).where(eq(sessions.ownerId, ownerId));
    }
    await pool.end();
  });

  function create(key: string, payload: unknown = body, ownerId = owner) {
    return app.request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": ownerId,
        "Idempotency-Key": key,
      },
      body: JSON.stringify(payload),
    });
  }

  async function rowsFor(sessionId: string) {
    const [[s], [t], [q], [u]] = await Promise.all([
      db
        .select({ n: count() })
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
      db
        .select({ n: count() })
        .from(turns)
        .where(eq(turns.sessionId, sessionId)),
      db
        .select({ n: count() })
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, sessionId)),
      db
        .select({ n: count() })
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ]);
    return { sessions: s?.n, turns: t?.n, queue: q?.n, unassigned: u?.n };
  }

  test("accepts session, first turn, queue row, receipt and idempotency key atomically", async () => {
    const response = await create("create-1");
    expect(response.status).toBe(201);
    const created = createSessionResponseSchema.parse(await response.json());
    expect(created).toMatchObject({
      turn_id: "1",
      receipt_status: "accepted",
      status: "queued",
    });
    expect(await rowsFor(created.session_id)).toEqual({
      sessions: 1,
      turns: 1,
      queue: 1,
      unassigned: 1,
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, created.receipt_id));
    expect(receipt).toMatchObject({
      ownerId: owner,
      operation: "create_session",
      status: "accepted",
      targetRef: {
        session_id: created.session_id,
        turn_id: "1",
        request_id: null,
      },
    });

    const replay = await create("create-1");
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);

    const conflict = await create("create-1", {
      ...body,
      message: "different",
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (
        await db
          .select({ n: count() })
          .from(receipts)
          .where(eq(receipts.ownerId, owner))
      )[0]?.n,
    ).toBe(1);
  });

  test("10 concurrent creates with one key produce one session, turn and receipt", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => create("race-1")),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    const sessionId = createSessionResponseSchema.parse(bodies[0]).session_id;
    expect(await rowsFor(sessionId)).toMatchObject({
      sessions: 1,
      turns: 1,
      queue: 1,
    });
    const [keyed] = await db
      .select({ n: count() })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "race-1"));
    expect(keyed?.n).toBe(1);
  });

  test("detail matches the contract and hides other owners' sessions", async () => {
    const created = createSessionResponseSchema.parse(
      await (await create("detail-1")).json(),
    );
    const response = await app.request(`/v1/sessions/${created.session_id}`, {
      headers: { "X-Owner-Id": owner },
    });
    expect(response.status).toBe(200);
    const detail = getSessionResponseSchema.parse(await response.json());
    expect(detail).toMatchObject({
      id: created.session_id,
      admission_state: "active",
      status: "queued",
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        profile_id: "claude-coding-v1",
      },
      repository_id: "sample-app",
      current_turn_id: null,
      queued_turn_count: 1,
      execution: null,
      pending_request_count: 0,
      durability: { checkpoint_revision: null, last_completed_turn_id: null },
    });
    expect(JSON.stringify(detail)).not.toContain("example.invalid");

    const foreign = await app.request(`/v1/sessions/${created.session_id}`, {
      headers: { "X-Owner-Id": stranger },
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.details).toBeNull();
  });

  test("lists 150 sessions through stable cursors without duplicates or gaps", async () => {
    const listOwner = `owner-${crypto.randomUUID()}`;
    const ids = new Set<string>();
    for (let index = 0; index < 150; index += 1) {
      const response = await create(`list-${index}`, body, listOwner);
      ids.add(
        createSessionResponseSchema.parse(await response.json()).session_id,
      );
    }
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url = `/v1/sessions?status=queued&limit=40${cursor ? `&cursor=${cursor}` : ""}`;
        const page = listSessionsResponseSchema.parse(
          await (
            await app.request(url, { headers: { "X-Owner-Id": listOwner } })
          ).json(),
        );
        seen.push(...page.items.map((item) => item.id));
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBe(4);
      expect(new Set(seen).size).toBe(150);
      expect(new Set(seen)).toEqual(ids);

      const defaults = listSessionsResponseSchema.parse(
        await (
          await app.request("/v1/sessions", {
            headers: { "X-Owner-Id": listOwner },
          })
        ).json(),
      );
      expect(defaults.items).toHaveLength(50);
      const forged = (created_at: string, id: string = crypto.randomUUID()) =>
        Buffer.from(JSON.stringify({ created_at, id })).toString("base64url");
      for (const cursor of [
        "nope",
        forged("2026-01-01T00:00:00Z", "not-a-uuid"),
        forged("0"),
        forged("2026-13-45 99:00:00+00"),
      ]) {
        const bad = await app.request(`/v1/sessions?cursor=${cursor}`, {
          headers: { "X-Owner-Id": listOwner },
        });
        expect(bad.status).toBe(400);
      }
    } finally {
      for (const id of ids) {
        await db.delete(queueMessages).where(eq(queueMessages.sessionId, id));
        await db
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, id));
        await db.delete(turns).where(eq(turns.sessionId, id));
      }
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.principal, listOwner));
      await db.delete(receipts).where(eq(receipts.ownerId, listOwner));
      await db.delete(sessions).where(eq(sessions.ownerId, listOwner));
    }
  }, 60_000);
});
