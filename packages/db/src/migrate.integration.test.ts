import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { migrateDatabase } from "./migrate.ts";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;

integrationTest(
  "adopts a raw M0 database and upgrades it through Drizzle",
  async () => {
    const adminUrl = new URL(databaseUrl ?? "");
    adminUrl.pathname = "/postgres";
    const databaseName = `m0_upgrade_${randomUUID().replaceAll("-", "_")}`;
    const quotedDatabase = `"${databaseName}"`;
    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${quotedDatabase}`);

    const testUrl = new URL(databaseUrl ?? "");
    testUrl.pathname = `/${databaseName}`;
    const legacy = new Pool({ connectionString: testUrl.toString(), max: 1 });
    try {
      const migration = await readFile(
        join(import.meta.dir, "../migrations/0000_gifted_morg.sql"),
        "utf8",
      );
      await legacy.query(migration);
      await legacy.end();

      await migrateDatabase(testUrl.toString());
      await migrateDatabase(testUrl.toString());

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
        const journal = await verified.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
        );
        expect(column.rows[0]?.claim_token).toBe(true);
        expect(journal.rows[0]?.count).toBe("2");
      } finally {
        await verified.end();
      }
    } finally {
      if (!legacy.ended) await legacy.end();
      await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase}`);
      await admin.end();
    }
  },
  30_000,
);
