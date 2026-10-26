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
} from "@werft-ai/testkit/postgres";
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
  // 0137, 0139: agent versions, releases and their audit rows are
  // insert-only; a release takes its first approval and nothing else.
  "function agent_releases_approve_once() trigger language plpgsql volatility=v parallel=u body md5 c6e3025aa20a67be3dc0885bb3301b1b",
  "function agents_reject_mutation() trigger language plpgsql volatility=v parallel=u body md5 f434237a3126c21bab918af2558fbc88",
  "function authz_decisions_refuse_update() trigger language plpgsql volatility=v parallel=u body md5 f3f5febb7e684f1ec6da6675a5dc196c",
  // 0143: an agent identity's credential name is never an agent's.
  "function credential_bindings_exclusive_target() trigger language plpgsql volatility=v parallel=u body md5 55270e3870adbfee5a5edd2ab0daf6a8",
  // 0000: the queue's admission count.
  "function queue_unassigned_session_count() double precision language sql volatility=s parallel=u body md5 77ab23e0fa3455549b846ff0e7980c2a",
  // 0172: a system pause's reason is cleared once the session leaves it.
  "function sessions_clear_pause_reason() trigger language plpgsql volatility=v parallel=u body md5 42f7916898b6ee5d3ea948c318a3d61c",
  // 0127, capped by 0129: a session's provider tokens are counted as usage
  // rows are inserted; usage_breakdown_rollup also keeps session_model_usage.
  "function sessions_count_provider_tokens() trigger language plpgsql volatility=v parallel=u body md5 d379ea7e669588977ef342b8f7d882d5",
  // 0107: retained input is charged to storage_usage as turns are inserted.
  "function storage_usage_charge_turn() trigger language plpgsql volatility=v parallel=u body md5 181d4bb80e87699778f44b2c2d4b738f",
  // 0170: tool_call_days' duration histogram, filled and summed in SQL.
  "function tool_hist(integer, integer) integer[] language internal volatility=i parallel=u body md5 3eb6d2f5e7ee95ed566dd6cdda54dac3",
  "function tool_hist_add(a integer[], b integer[]) integer[] language sql volatility=i parallel=s body md5 06b5f26e393c4c8ceab73150900e0667",
  "function tool_hist_step(state integer[], bucket integer, delta integer) integer[] language sql volatility=i parallel=s body md5 20e7f2741f305c44a7febf7acc1b90ff",
  "function tool_hist_sum(integer[]) integer[] language internal volatility=i parallel=u body md5 3eb6d2f5e7ee95ed566dd6cdda54dac3",
  "function tool_ms_bucket(ms bigint) integer language sql volatility=i parallel=s body md5 6a2f107430551d1a26c5afd7b02f7985",
  "trigger CREATE TRIGGER agent_activation_events_insert_only BEFORE DELETE OR UPDATE ON public.agent_activation_events FOR EACH ROW EXECUTE FUNCTION agents_reject_mutation() enabled=O",
  "trigger CREATE TRIGGER agent_releases_approve_once BEFORE DELETE OR UPDATE ON public.agent_releases FOR EACH ROW EXECUTE FUNCTION agent_releases_approve_once() enabled=O",
  "trigger CREATE TRIGGER agent_versions_insert_only BEFORE DELETE OR UPDATE ON public.agent_versions FOR EACH ROW EXECUTE FUNCTION agents_reject_mutation() enabled=O",
  "trigger CREATE TRIGGER authz_decisions_append_only BEFORE UPDATE ON public.authz_decisions FOR EACH ROW EXECUTE FUNCTION authz_decisions_refuse_update() enabled=O",
  "trigger CREATE TRIGGER credential_bindings_exclusive_target BEFORE INSERT OR UPDATE ON public.credential_bindings FOR EACH ROW EXECUTE FUNCTION credential_bindings_exclusive_target() enabled=O",
  "trigger CREATE TRIGGER provider_usage_count_tokens AFTER INSERT ON public.provider_usage FOR EACH ROW EXECUTE FUNCTION sessions_count_provider_tokens() enabled=O",
  "trigger CREATE TRIGGER sessions_clear_pause_reason BEFORE UPDATE ON public.sessions FOR EACH ROW WHEN (((new.pause_reason IS NOT NULL) AND (new.admission_state <> ALL (ARRAY['pausing'::admission_state, 'paused'::admission_state])))) EXECUTE FUNCTION sessions_clear_pause_reason() enabled=O",
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
    // The snapshot still has the constraint, so the folder check passes, and
    // the migration applies without it.
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
