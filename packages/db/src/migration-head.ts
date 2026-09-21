import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationHead {
  readonly tag: string;
  /** Drizzle stores this folder timestamp as created_at in its journal table. */
  readonly when: number;
}

const journalPath = join(import.meta.dir, "../migrations/meta/_journal.json");

// The newest entry of migrations/meta/_journal.json: the schema version this
// build of the code expects to find in the database.
export function expectedMigrationHead(): MigrationHead {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const last = journal.entries.at(-1);
  if (!last) {
    throw new Error("Migration journal is empty");
  }
  return { tag: last.tag, when: last.when };
}

// Newest journal row as text, or null when nothing was ever applied; raises
// 42P01 on a database that has no journal table at all.
export const APPLIED_MIGRATION_HEAD_SQL =
  'SELECT max(created_at)::text AS applied FROM "drizzle"."__drizzle_migrations"';
