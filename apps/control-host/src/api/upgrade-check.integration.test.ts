import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "@werft-ai/observability";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { Pool } from "pg";
import { databaseUnused } from "./upgrade-check.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;
const unused = databaseUnused(createLogger({ sinks: [{ write() {} }] }));

integration("databaseUnused on PostgreSQL", () => {
  let database: TempDatabase;

  afterEach(() => database.drop());

  async function given(options: { migrate: boolean }, ...sql: string[]) {
    database = await createTempDatabase({
      ...options,
      prefix: "upgrade_check",
    });
    const pool = new Pool({ connectionString: database.url });
    try {
      for (const statement of sql) await pool.query(statement);
    } finally {
      await pool.end();
    }
    return unused(database.url);
  }

  const journal = [
    'CREATE SCHEMA "drizzle"',
    'CREATE TABLE "drizzle"."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  ];

  test("a database never migrated is unused", async () => {
    expect(await given({ migrate: false })).toBe(true);
  });

  test("a journal with no row, which a failed migrate leaves, is unused", async () => {
    expect(await given({ migrate: false }, ...journal)).toBe(true);
  });

  test("a migrated database with no session is unused", async () => {
    expect(await given({ migrate: true })).toBe(true);
  });

  test("a session of any kind, with no checkpoint, is use", async () => {
    expect(
      await given(
        { migrate: false },
        "CREATE TABLE sessions (id text)",
        "INSERT INTO sessions VALUES ('s-1')",
      ),
    ).toBe(false);
  });

  test("a schema without sessions is use, not a first install", async () => {
    expect(
      await given({ migrate: false }, "CREATE TABLE checkpoints (id text)"),
    ).toBe(false);
  });

  test("journal rows without a schema are use", async () => {
    expect(
      await given(
        { migrate: false },
        ...journal,
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('h', 1)`,
      ),
    ).toBe(false);
  });
});
