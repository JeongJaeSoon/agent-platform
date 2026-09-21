import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const migrationsFolder = join(import.meta.dir, "../migrations");
const expectedLegacyTables = [
  "api_keys",
  "events",
  "pull_requests",
  "queue_messages",
  "sessions",
  "turns",
  "unassigned_sessions",
  "workers",
] as const;

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await adoptLegacyM0Schema(pool);
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

async function adoptLegacyM0Schema(pool: Pool): Promise<void> {
  const state = await pool.query<{
    claim_token: boolean;
    migration_journal: string | null;
    receipts: string | null;
    sessions: string | null;
  }>(`
    SELECT
      to_regclass('public.sessions')::text AS sessions,
      to_regclass('public.events_attempt_sequence_uniq')::text AS receipts,
      to_regclass('drizzle.__drizzle_migrations')::text AS migration_journal,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'queue_messages'
          AND column_name = 'claim_token'
      ) AS claim_token
  `);
  const current = state.rows[0];
  if (!current || current.sessions === null || current.migration_journal) {
    return;
  }

  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const present = new Set(tables.rows.map(({ table_name }) => table_name));
  const missing = expectedLegacyTables.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to adopt incomplete legacy M0 schema; missing: ${missing.join(", ")}`,
    );
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  // 0002 is detected by its last statement so a partially applied raw init
  // is not recorded as complete.
  if (current.receipts !== null && !current.claim_token) {
    throw new Error(
      "Refusing to adopt legacy schema with migration 0002 applied before 0001",
    );
  }
  const appliedCount =
    current.receipts !== null ? 3 : current.claim_token ? 2 : 1;
  if (migrations.length < appliedCount) {
    throw new Error(
      `Legacy schema requires ${appliedCount} migration files, found ${migrations.length}`,
    );
  }
  const applied = migrations.slice(0, appliedCount);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    for (const migration of applied) {
      await client.query(
        'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
        [migration.hash, migration.folderMillis],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations");
  }
  await migrateDatabase(databaseUrl);
}
