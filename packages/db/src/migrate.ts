import { join } from "node:path";
import {
  createLogger,
  type StructuredLogger,
} from "@agent-platform/observability";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool, PoolClient } from "pg";
import { createEnforcedPool, type PoolTimeouts } from "./pool.ts";

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

export interface MigrationSummary {
  /** Journal rows written for a legacy M0 schema that predates Drizzle. */
  readonly adopted: number;
  /** Migrations newly applied by Drizzle in this run. */
  readonly applied: number;
  /** Journal rows after the run. */
  readonly total: number;
}

// Bounded so a frozen database fails the one-shot migrate instead of holding
// `up` forever, and loose enough for a DDL statement that rewrites a table
// or waits out a lock held by a running API. Raise it, or make it a setting,
// once a migration needs longer.
export const MIGRATION_POOL_TIMEOUTS: PoolTimeouts = {
  connectMs: 5_000,
  statementMs: 300_000,
  queryMs: 330_000,
};

export interface MigrateDatabaseOptions {
  readonly logger?: StructuredLogger;
  readonly timeouts?: PoolTimeouts;
}

export async function migrateDatabase(
  databaseUrl: string,
  options: MigrateDatabaseOptions = {},
): Promise<MigrationSummary> {
  const logger = options.logger ?? createLogger();
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    "migrate",
    options.timeouts ?? MIGRATION_POOL_TIMEOUTS,
  );
  try {
    const adopted = await adoptLegacyM0Schema(pool);
    const before = await countJournal(pool);
    await migrate(drizzle(pool), { migrationsFolder });
    const total = await countJournal(pool);
    const summary: MigrationSummary = {
      adopted,
      applied: total - before,
      total,
    };
    const outcome =
      adopted > 0 ? "adopted" : summary.applied > 0 ? "applied" : "noop";
    logger.info(`db.migrate.${outcome}`, { ...summary });
    return summary;
  } finally {
    await pool.end();
  }
}

async function countJournal(pool: Pool): Promise<number> {
  const journal = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists",
  );
  if (!journal.rows[0]?.exists) {
    return 0;
  }
  const count = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
  );
  return Number(count.rows[0]?.count ?? 0);
}

async function adoptLegacyM0Schema(pool: Pool): Promise<number> {
  const state = await pool.query<{
    claim_token: boolean;
    migration_journal: string | null;
    receipts: string | null;
    sessions: string | null;
    turn_sequence: string | null;
  }>(`
    SELECT
      to_regclass('public.sessions')::text AS sessions,
      to_regclass('public.events_attempt_sequence_uniq')::text AS receipts,
      to_regclass('public.turns_session_sequence_uniq')::text AS turn_sequence,
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
    return 0;
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
  // 0002/0003 are detected by their last statement so a partially applied
  // raw init is not recorded as complete.
  const applied0002 = current.receipts !== null;
  const applied0003 = current.turn_sequence !== null;
  if ((applied0002 && !current.claim_token) || (applied0003 && !applied0002)) {
    throw new Error(
      "Refusing to adopt legacy schema with migrations applied out of order",
    );
  }
  const appliedCount = applied0003
    ? 4
    : applied0002
      ? 3
      : current.claim_token
        ? 2
        : 1;
  if (migrations.length < appliedCount) {
    throw new Error(
      `Legacy schema requires ${appliedCount} migration files, found ${migrations.length}`,
    );
  }
  const applied = migrations.slice(0, appliedCount);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await recordAppliedMigrations(
      client,
      applied.map((migration) => ({
        hash: migration.hash,
        when: migration.folderMillis,
      })),
    );
    await client.query("COMMIT");
    return applied.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Writes journal rows for migrations that were applied by hand, in the shape
 * Drizzle's migrator reads (`hash`, `created_at` = folder millis). Also used
 * by tests that need a database standing at one exact migration.
 */
export async function recordAppliedMigrations(
  client: Pick<PoolClient, "query">,
  migrations: readonly { hash: string; when: number }[],
): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  for (const migration of migrations) {
    await client.query(
      'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
      [migration.hash, migration.when],
    );
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations");
  }
  await migrateDatabase(databaseUrl);
}
