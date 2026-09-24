import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, MemoryLogSink } from "@agent-platform/observability";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { Pool } from "pg";
import { migrateDatabase } from "./migrate.ts";

const integrationTest = testDatabaseUrl() ? test : test.skip;

function captureLogger() {
  const sink = new MemoryLogSink();
  return { logger: createLogger({ sinks: [sink] }), sink };
}

integrationTest(
  "adopts a raw M0 database and upgrades it through Drizzle",
  async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "m0_upgrade",
    });
    const testUrl = new URL(database.url);
    const legacy = new Pool({ connectionString: testUrl.toString(), max: 1 });
    try {
      const migration = await readFile(
        join(import.meta.dir, "../migrations/0000_gifted_morg.sql"),
        "utf8",
      );
      await legacy.query(migration);
      const sessionId = randomUUID();
      const turn = await legacy.query<{ id: string }>(
        `
          INSERT INTO sessions (id, owner_id, repo_url, branch, status)
          VALUES ($1, 'owner', 'https://example.invalid/repo.git', 'main', 'stopped')
          RETURNING id
        `,
        [sessionId],
      );
      await legacy.query(
        `
          INSERT INTO turns (session_id, message, status)
          VALUES ($1, 'legacy message', 'done')
        `,
        [turn.rows[0]?.id],
      );
      await legacy.end();

      const { logger, sink } = captureLogger();
      const first = await migrateDatabase(testUrl.toString(), { logger });
      const second = await migrateDatabase(testUrl.toString(), { logger });
      expect(first).toEqual({ adopted: 1, applied: 30, total: 31 });
      expect(second).toEqual({ adopted: 0, applied: 0, total: 31 });
      expect(
        sink.records.map(({ level, message, fields }) => ({
          level,
          message,
          fields,
        })),
      ).toEqual([
        {
          level: "info",
          message: "db.migrate.adopted",
          fields: { adopted: 1, applied: 30, total: 31 },
        },
        {
          level: "info",
          message: "db.migrate.noop",
          fields: { adopted: 0, applied: 0, total: 31 },
        },
      ]);

      const verified = new Pool({
        connectionString: testUrl.toString(),
        max: 1,
      });
      try {
        const column = await verified.query<{ claim_token: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'queue_messages'
              AND column_name = 'claim_token'
          ) AS claim_token
        `);
        const session = await verified.query<{ admission_state: string }>(
          "SELECT admission_state FROM sessions WHERE id = $1",
          [sessionId],
        );
        const turnStatus = await verified.query<{
          sequence: number;
          status: string;
        }>("SELECT status, sequence FROM turns WHERE session_id = $1", [
          sessionId,
        ]);
        const tables = await verified.query<{ table_name: string }>(`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('receipts', 'pending_requests', 'checkpoints', 'executions')
          ORDER BY table_name
        `);
        const journal = await verified.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
        );
        const storage = await verified.query<{ bytes: string }>(
          "SELECT bytes::text FROM storage_usage WHERE scope = 'installation'",
        );
        expect(column.rows[0]?.claim_token).toBe(true);
        // Retained input counts from the first acceptance after the upgrade.
        expect(storage.rows[0]?.bytes).toBe(
          String(Buffer.byteLength("legacy message")),
        );
        expect(session.rows[0]?.admission_state).toBe("stopped");
        expect(turnStatus.rows[0]?.status).toBe("completed");
        expect(turnStatus.rows[0]?.sequence).toBe(1);
        expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
          "checkpoints",
          "executions",
          "pending_requests",
          "receipts",
        ]);
        expect(journal.rows[0]?.count).toBe("31");
      } finally {
        await verified.end();
      }
    } finally {
      if (!legacy.ended) await legacy.end();
      await database.drop();
    }
  },
  30_000,
);

integrationTest(
  "adopts a database initialized with all raw migrations",
  async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "m0_initdb",
    });
    const testUrl = new URL(database.url);
    const legacy = new Pool({ connectionString: testUrl.toString(), max: 1 });
    try {
      // The compose initdb mounts stop at 0003: adoptLegacyM0Schema only
      // recognises up to 0003, so 0004+ must be applied by the migrator.
      for (const filename of [
        "0000_gifted_morg.sql",
        "0001_giant_sphinx.sql",
        "0002_thin_victor_mancha.sql",
        "0003_lethal_blue_blade.sql",
      ]) {
        await legacy.query(
          await readFile(
            join(import.meta.dir, `../migrations/${filename}`),
            "utf8",
          ),
        );
      }
      await legacy.end();

      const { logger, sink } = captureLogger();
      const first = await migrateDatabase(testUrl.toString(), { logger });
      const second = await migrateDatabase(testUrl.toString(), { logger });
      expect(first).toEqual({ adopted: 4, applied: 27, total: 31 });
      expect(second).toEqual({ adopted: 0, applied: 0, total: 31 });
      expect(sink.records.map(({ message }) => message)).toEqual([
        "db.migrate.adopted",
        "db.migrate.noop",
      ]);

      const verified = new Pool({
        connectionString: testUrl.toString(),
        max: 1,
      });
      try {
        const journal = await verified.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
        );
        expect(journal.rows[0]?.count).toBe("31");
      } finally {
        await verified.end();
      }
    } finally {
      if (!legacy.ended) await legacy.end();
      await database.drop();
    }
  },
  30_000,
);

integrationTest(
  "applies every migration to a fresh database and reports a no-op on rerun",
  async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "fresh",
    });
    const testUrl = new URL(database.url);
    try {
      const { logger, sink } = captureLogger();
      const first = await migrateDatabase(testUrl.toString(), { logger });
      const second = await migrateDatabase(testUrl.toString(), { logger });
      expect(first).toEqual({ adopted: 0, applied: 31, total: 31 });
      expect(second).toEqual({ adopted: 0, applied: 0, total: 31 });
      expect(sink.records.map(({ message }) => message)).toEqual([
        "db.migrate.applied",
        "db.migrate.noop",
      ]);
    } finally {
      await database.drop();
    }
  },
  30_000,
);
