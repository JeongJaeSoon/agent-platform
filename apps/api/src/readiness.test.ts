import { afterAll, describe, expect, test } from "bun:test";
import { expectedMigrationHead } from "@agent-platform/db";
import { installationLimitProblems } from "@agent-platform/platform";
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
    expect(expectedMigrationHead().tag).toBe("0116_numerous_lord_hawal");
  });

  test("passes on a migrated database with the required configuration", async () => {
    const probe = createReadinessProbe({
      db: await database(true),
      requiredEnv,
      environment,
    });
    expect(await probe()).toEqual({ ready: true });
  }, 30_000);

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

  test("stays ready when the database is ahead by a later migration", async () => {
    // DESIGN.md §11.5: the migration Job runs before the rollout, so the
    // previous build must keep serving on a database that is one step ahead.
    const ahead = await database(true);
    await ahead.query(
      'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES (\'future\', 9999999999999)',
    );
    expect(
      await createReadinessProbe({ db: ahead, requiredEnv, environment })(),
    ).toEqual({ ready: true });
  }, 30_000);

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
      "0116_numerous_lord_hawal",
    );

    // Same timestamp, different SQL behind it: not the schema this build ships.
    const rewritten = await database(true);
    await rewritten.query(
      `UPDATE "drizzle"."__drizzle_migrations" SET hash = 'deadbeef' WHERE created_at = ${expectedMigrationHead().when}`,
    );
    expect(
      await createReadinessProbe({ db: rewritten, requiredEnv, environment })(),
    ).toMatchObject({ ready: false, check: "schema" });

    // The head alone is not enough: an earlier migration missing or rewritten
    // must fail too.
    const gap = await database(true);
    await gap.query(
      'DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at = (SELECT min(created_at) FROM "drizzle"."__drizzle_migrations")',
    );
    const gapResult = await createReadinessProbe({
      db: gap,
      requiredEnv,
      environment,
    })();
    expect(gapResult).toMatchObject({ ready: false, check: "schema" });
    const middle = await database(true);
    await middle.query(
      'UPDATE "drizzle"."__drizzle_migrations" SET hash = \'deadbeef\' WHERE created_at = (SELECT min(created_at) FROM "drizzle"."__drizzle_migrations")',
    );
    expect(
      await createReadinessProbe({ db: middle, requiredEnv, environment })(),
    ).toMatchObject({ ready: false, check: "schema" });
  }, 30_000);

  test("fails the config check on invalid installation limits (94S-131)", async () => {
    const db = await database(true);
    const limits = {
      EXECUTION_SLOT_LIMIT: "10",
      MAX_TURN_SECONDS: "3600",
      PROVIDER_MAX_RETRIES: "2",
      QUEUED_INPUT_LIMIT_PER_SESSION: "20",
      SESSION_COST_LIMIT_USD: "25",
      STORAGE_LIMIT_BYTES: "1073741824",
    };
    const probe = (extra: Record<string, string | undefined>) =>
      createReadinessProbe({
        db,
        requiredEnv,
        configProblems: installationLimitProblems,
        environment: { ...environment, ...limits, ...extra },
      })();
    expect(await probe({})).toEqual({ ready: true });
    expect(
      await probe({ SESSION_COST_LIMIT_USD: undefined, MAX_TURN_SECONDS: "0" }),
    ).toEqual({
      ready: false,
      check: "config",
      reason:
        "configuration: MAX_TURN_SECONDS must be an integer from 1 to 604800, SESSION_COST_LIMIT_USD is required",
    });
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
      reason: "configuration: missing AUTH_MODE",
    });
    // A value outside the allowed set is a misconfiguration too: app.ts
    // would run "bogus" as api-key mode without complaint.
    expect(
      await createReadinessProbe({
        db,
        requiredEnv: [
          "DATABASE_URL",
          { name: "AUTH_MODE", allowed: ["none", "api-key"] },
        ],
        environment: { DATABASE_URL: "postgres://x", AUTH_MODE: "bogus" },
      })(),
    ).toEqual({
      ready: false,
      check: "config",
      reason: "configuration: AUTH_MODE must be one of none|api-key",
    });
    expect(
      await createReadinessProbe({
        db,
        requiredEnv: [{ name: "AUTH_MODE", allowed: ["none", "api-key"] }],
        environment: { AUTH_MODE: "api-key" },
      })(),
    ).toEqual({ ready: true });
    // app.ts compares the raw value, so surrounding whitespace is a typo
    // that would run in api-key mode; readiness must judge the same string.
    expect(
      await createReadinessProbe({
        db,
        requiredEnv: [{ name: "AUTH_MODE", allowed: ["none", "api-key"] }],
        environment: { AUTH_MODE: " none " },
      })(),
    ).toMatchObject({ ready: false, check: "config" });
  }, 30_000);
});
