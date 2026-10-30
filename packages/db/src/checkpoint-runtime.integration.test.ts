import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { readPointerRuntime } from "./checkpoint-runtime.ts";
import * as schema from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MIGRATIONS = join(import.meta.dir, "../migrations");

type Journal = { entries: Array<{ tag: string }> };

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "checkpoint-runtime-"));
  await mkdir(join(folder, "meta"));
  const journal: Journal = JSON.parse(
    await readFile(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
  );
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`no migration ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag } of entries) {
    await copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  return folder;
}

integration("checkpoint runtime columns, expand", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "checkpoint_runtime_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    before = await migrationsThrough("0195_github_workflow_dispatches");
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  test("a pointer committed before the columns reads as no recorded runtime", async () => {
    await migrate(db, { migrationsFolder: before });
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')`,
      [sessionId],
    );
    await pool.query(
      `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256)
       VALUES ($1, 0, 'sessions/s/checkpoints/0/manifest.json', $2)`,
      [sessionId, "a".repeat(64)],
    );
    await pool.query(
      "UPDATE sessions SET checkpoint_revision = 0 WHERE id = $1",
      [sessionId],
    );

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(
      (
        await pool.query(
          `SELECT runtime_engine, runtime_sdk_version, runtime_cli_version, runtime_profile_sha256
           FROM checkpoints WHERE session_id = $1`,
          [sessionId],
        )
      ).rows,
    ).toEqual([
      {
        runtime_engine: null,
        runtime_sdk_version: null,
        runtime_cli_version: null,
        runtime_profile_sha256: null,
      },
    ]);
    expect(await readPointerRuntime(db, sessionId)).toBeNull();
  }, 60_000);

  test("a session from before its pin columns keeps them null", async () => {
    const through = await migrationsThrough("0197_github_app_client_id");
    try {
      await migrate(db, { migrationsFolder: through });
    } finally {
      await rm(through, { recursive: true, force: true });
    }
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')`,
      [sessionId],
    );

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(
      (
        await pool.query(
          `SELECT first_worker_image, runtime_engine, runtime_sdk_version,
                  runtime_cli_version, runtime_profile_sha256
           FROM sessions WHERE id = $1`,
          [sessionId],
        )
      ).rows,
    ).toEqual([
      {
        first_worker_image: null,
        runtime_engine: null,
        runtime_sdk_version: null,
        runtime_cli_version: null,
        runtime_profile_sha256: null,
      },
    ]);
  }, 60_000);
});
