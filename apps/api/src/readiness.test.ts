import { afterAll, describe, expect, test } from "bun:test";
import { expectedMigrationHead } from "@agent-platform/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createReadinessProbe, type QueryRunner } from "./readiness.ts";

const migrationsFolder = `${import.meta.dir}/../../../packages/db/migrations`;
const databases: PGlite[] = [];

async function database(migrated: boolean): Promise<PGlite> {
  const client = new PGlite();
  databases.push(client);
  if (migrated) {
    await migrate(drizzle(client), { migrationsFolder });
  }
  return client;
}

afterAll(async () => {
  await Promise.all(databases.map((client) => client.close()));
});

const environment = { DATABASE_URL: "postgres://x", AUTH_MODE: "api-key" };
const requiredEnv = ["DATABASE_URL", "AUTH_MODE"];

describe("readiness probe", () => {
  test("journal head is the last migration tag", () => {
    expect(expectedMigrationHead().tag).toBe("0004_calm_blue_shield");
  });

  test("passes on a migrated database with the required configuration", async () => {
    const probe = createReadinessProbe({
      db: await database(true),
      requiredEnv,
      environment,
    });
    expect(await probe()).toEqual({ ready: true });
  });

  test("fails the database check when the query errors or hangs", async () => {
    const down: QueryRunner = {
      query: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      },
    };
    expect(
      await createReadinessProbe({ db: down, requiredEnv, environment })(),
    ).toMatchObject({ ready: false, check: "database" });
    const hung: QueryRunner = { query: () => new Promise(() => {}) };
    expect(
      await createReadinessProbe({
        db: hung,
        requiredEnv,
        environment,
        timeoutMs: 20,
      })(),
    ).toMatchObject({ ready: false, check: "database" });
  });

  test("fails the schema check on an unmigrated or stale database", async () => {
    const empty = await database(false);
    expect(
      await createReadinessProbe({ db: empty, requiredEnv, environment })(),
    ).toMatchObject({ ready: false, check: "schema" });

    const stale = await database(true);
    await stale.query(
      'DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at = (SELECT max(created_at) FROM "drizzle"."__drizzle_migrations")',
    );
    const result = await createReadinessProbe({
      db: stale,
      requiredEnv,
      environment,
    })();
    expect(result).toMatchObject({ ready: false, check: "schema" });
    expect(result.ready === false && result.reason).toContain(
      "0004_calm_blue_shield",
    );

    // Same timestamp, different SQL behind it: not the schema this build ships.
    const rewritten = await database(true);
    await rewritten.query(
      `UPDATE "drizzle"."__drizzle_migrations" SET hash = 'deadbeef' WHERE created_at = ${expectedMigrationHead().when}`,
    );
    expect(
      await createReadinessProbe({ db: rewritten, requiredEnv, environment })(),
    ).toMatchObject({ ready: false, check: "schema" });
  });

  test("fails the config check when a required variable is missing or blank", async () => {
    const db = await database(true);
    expect(
      await createReadinessProbe({
        db,
        requiredEnv,
        environment: { DATABASE_URL: "postgres://x", AUTH_MODE: " " },
      })(),
    ).toEqual({
      ready: false,
      check: "config",
      reason: "missing configuration: AUTH_MODE",
    });
  });
});
