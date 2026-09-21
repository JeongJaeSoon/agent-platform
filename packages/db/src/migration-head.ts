import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

export interface MigrationHead {
  readonly tag: string;
  /** Drizzle stores this folder timestamp as created_at in its journal table. */
  readonly when: number;
  /** sha256 of the migration SQL, as Drizzle records it in its journal table. */
  readonly hash: string;
}

const migrationsFolder = join(import.meta.dir, "../migrations");

// The newest packaged migration: the schema version this build of the code
// expects to find in the database. Read through Drizzle's own loader so the
// hash matches what its migrator (and adoptLegacyM0Schema) wrote.
export function expectedMigrationHead(): MigrationHead {
  const last = readMigrationFiles({ migrationsFolder }).at(-1);
  if (!last) {
    throw new Error("Migration journal is empty");
  }
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  const tag = journal.entries.find(
    (entry) => entry.when === last.folderMillis,
  )?.tag;
  if (!tag) {
    throw new Error(`No journal entry for migration ${last.folderMillis}`);
  }
  return { tag, when: last.folderMillis, hash: last.hash };
}

// Newest journal row, or no rows when nothing was ever applied; raises 42P01
// on a database that has no journal table at all.
export const APPLIED_MIGRATION_HEAD_SQL =
  'SELECT hash, created_at::text AS applied FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1';
