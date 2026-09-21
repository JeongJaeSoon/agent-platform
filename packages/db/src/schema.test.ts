import { afterEach, describe, expect, test } from "bun:test";
import {
  ADMISSION_STATE_VALUES,
  RECEIPT_STATUS_VALUES,
  SESSION_STATUS_VALUES,
} from "@agent-platform/contracts";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  admissionState,
  checkpoints,
  events,
  idempotencyKeys,
  receiptStatus,
  receipts,
  sessionStatus,
  sessions,
} from "./schema.ts";

const databases: PGlite[] = [];

async function migratedDatabase() {
  const client = new PGlite();
  databases.push(client);
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
  return { client, db };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database schema", () => {
  test("uses the contract session status values", () => {
    expect(sessionStatus.enumValues).toEqual([...SESSION_STATUS_VALUES]);
  });

  test("uses the contract admission and receipt status values", () => {
    expect(admissionState.enumValues).toEqual([...ADMISSION_STATE_VALUES]);
    expect(receiptStatus.enumValues).toEqual([...RECEIPT_STATUS_VALUES]);
  });

  test("applies the migration twice without changing the schema", async () => {
    const { client, db } = await migratedDatabase();
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(result.rows.map(({ tablename }) => tablename)).toEqual([
      "api_keys",
      "checkpoints",
      "events",
      "executions",
      "idempotency_keys",
      "pending_requests",
      "pull_requests",
      "queue_messages",
      "receipts",
      "sessions",
      "turns",
      "unassigned_sessions",
      "workers",
    ]);
  });

  test("applies defaults to the new session control columns", async () => {
    const { db } = await migratedDatabase();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });

    const [session] = await db
      .select({
        admissionState: sessions.admissionState,
        revision: sessions.revision,
        leaseEpoch: sessions.leaseEpoch,
      })
      .from(sessions);
    expect(session).toEqual({
      admissionState: "active",
      revision: 0,
      leaseEpoch: 0,
    });
  });

  test("enforces idempotency and checkpoint composite primary keys", async () => {
    const { db } = await migratedDatabase();
    const sessionId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: "owner",
      operation: "create_session",
      targetRef: { session_id: sessionId },
    });
    const idempotencyKey = {
      principal: "owner",
      operation: "create_session",
      resource: sessionId,
      key: "request-1",
      payloadHash: "hash",
      receiptId,
    };
    await db.insert(idempotencyKeys).values(idempotencyKey);
    let idempotencyError: unknown;
    try {
      await db.insert(idempotencyKeys).values(idempotencyKey);
    } catch (error) {
      idempotencyError = error;
    }
    expect(idempotencyError).toBeDefined();

    const checkpoint = {
      sessionId,
      revision: 1,
      manifestRef: "s3://bucket/manifest.json",
      manifestSha256: "sha256",
    };
    await db.insert(checkpoints).values(checkpoint);
    let checkpointError: unknown;
    try {
      await db.insert(checkpoints).values(checkpoint);
    } catch (error) {
      checkpointError = error;
    }
    expect(checkpointError).toBeDefined();
  });

  test("keeps event ids monotonic within a session", async () => {
    const { db } = await migratedDatabase();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
    });
    const inserted = await db
      .insert(events)
      .values([
        { sessionId, type: "status", payload: { sequence: 1 } },
        { sessionId, type: "status", payload: { sequence: 2 } },
        { sessionId, type: "status", payload: { sequence: 3 } },
      ])
      .returning({ id: events.id });
    expect(inserted.map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  test("stores only a key hash and keeps the partial pod index", async () => {
    const { client } = await migratedDatabase();
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys' ORDER BY column_name",
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "created_at",
      "id",
      "key_hash",
      "owner_id",
      "revoked_at",
    ]);
    const index = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'sessions_pod_uniq'",
    );
    expect(index.rows[0]?.indexdef).toContain("WHERE (pod_id IS NOT NULL)");
  });
});
