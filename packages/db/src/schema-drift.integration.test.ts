import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { MIGRATIONS_FOLDER } from "./migration-folder.ts";
import * as schema from "./schema.ts";
import {
  diffCatalogs,
  type Execute,
  readCatalog,
  schemaStatements,
} from "./schema-drift.ts";

const integrationTest = testDatabaseUrl() ? test : test.skip;

// What the migrations hold that schema.ts cannot declare: Drizzle has no
// syntax for functions or triggers, so these are written by hand in SQL.
// Listed exactly, so a migration that loses, disables or rewrites one fails
// as well; a migration that changes one on purpose updates its line here.
const MIGRATIONS_ONLY = [
  // 0000: the queue's admission count.
  "function queue_unassigned_session_count() double precision language sql volatility=s parallel=u body md5 77ab23e0fa3455549b846ff0e7980c2a",
  // 0107: retained input is charged to storage_usage as turns are inserted.
  "function storage_usage_charge_turn() trigger language plpgsql volatility=v parallel=u body md5 181d4bb80e87699778f44b2c2d4b738f",
  "trigger CREATE TRIGGER turns_charge_storage AFTER INSERT ON public.turns FOR EACH ROW EXECUTE FUNCTION storage_usage_charge_turn() enabled=O",
];

const databases: TempDatabase[] = [];
const pools: Pool[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  await Promise.all(databases.splice(0).map((database) => database.drop()));
  for (const folder of folders.splice(0)) {
    rmSync(folder, { force: true, recursive: true });
  }
});

async function database(options: { migrate: boolean }) {
  const created = await createTempDatabase({
    migrate: options.migrate,
    prefix: "schema_drift",
  });
  databases.push(created);
  const pool = new Pool({ connectionString: created.url, max: 1 });
  pools.push(pool);
  const execute: Execute = async (sql) => (await pool.query(sql)).rows;
  return { execute, pool };
}

async function schemaCatalog(): Promise<string[]> {
  const { execute } = await database({ migrate: false });
  for (const statement of await schemaStatements(schema)) {
    await execute(statement);
  }
  return readCatalog(execute);
}

integrationTest(
  "the migrated schema is the schema schema.ts declares",
  async () => {
    const migrated = await database({ migrate: true });
    expect(
      diffCatalogs(await readCatalog(migrated.execute), await schemaCatalog()),
    ).toEqual({ migrationsOnly: MIGRATIONS_ONLY, schemaOnly: [] });
  },
  60_000,
);

integrationTest(
  "a CHECK missing from a migration's SQL is caught",
  async () => {
    // 94S-298's case: the snapshot still has the constraint, so the folder
    // check passes, and the migration applies without it.
    const folder = mkdtempSync(join(tmpdir(), "migrations-"));
    folders.push(folder);
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const file = join(folder, "0111_next_havok.sql");
    const original = readFileSync(file, "utf8");
    const edited = original
      .split("\n")
      .filter((line) => !line.includes("worker_launches_launch_attempts_check"))
      .join("\n");
    expect(edited).not.toBe(original);
    writeFileSync(file, edited);

    const migrated = await database({ migrate: false });
    await migrate(drizzle(migrated.pool), { migrationsFolder: folder });

    expect(
      diffCatalogs(await readCatalog(migrated.execute), await schemaCatalog()),
    ).toEqual({
      migrationsOnly: MIGRATIONS_ONLY,
      schemaOnly: [
        "constraint worker_launches.worker_launches_launch_attempts_check CHECK ((launch_attempts >= 0))",
      ],
    });
  },
  60_000,
);
