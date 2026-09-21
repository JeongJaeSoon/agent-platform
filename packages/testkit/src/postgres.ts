import { randomUUID } from "node:crypto";
import { migrateDatabase } from "@agent-platform/db/migrate";
import { Pool } from "pg";

export type TempDatabase = {
  /** Drops the database. Safe to call more than once. */
  drop(): Promise<void>;
  name: string;
  url: string;
};

export type TempDatabaseOptions = {
  /**
   * Connection URL of a server the test may create databases on. Defaults to
   * `QUEUE_DATABASE_URL`, the opt-in variable README and CI already use.
   */
  adminUrl?: string;
  /** Apply the Drizzle migrations right after creation. Defaults to true. */
  migrate?: boolean;
  /** Prefix of the generated database name. */
  prefix?: string;
};

/** The opt-in URL for real PostgreSQL integration tests, if set. */
export function testDatabaseUrl(): string | undefined {
  return process.env.QUEUE_DATABASE_URL || undefined;
}

export async function createTempDatabase(
  options: TempDatabaseOptions = {},
): Promise<TempDatabase> {
  const adminUrl = options.adminUrl ?? testDatabaseUrl();
  if (adminUrl === undefined) {
    throw new Error(
      "createTempDatabase requires QUEUE_DATABASE_URL or options.adminUrl",
    );
  }
  const name = `${options.prefix ?? "testkit"}_${randomUUID().replaceAll("-", "_")}`;
  const quoted = `"${name}"`;
  const admin = new URL(adminUrl);
  admin.pathname = "/postgres";
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;

  await withAdminPool(admin.toString(), (pool) =>
    pool.query(`CREATE DATABASE ${quoted}`),
  );
  let dropped = false;
  const drop = async () => {
    if (dropped) return;
    dropped = true;
    await withAdminPool(admin.toString(), (pool) =>
      pool.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`),
    );
  };
  if (options.migrate ?? true) {
    try {
      await migrateDatabase(target.toString());
    } catch (error) {
      await drop();
      throw error;
    }
  }
  return { drop, name, url: target.toString() };
}

export async function withTempDatabase<T>(
  fn: (database: TempDatabase) => Promise<T>,
  options: TempDatabaseOptions = {},
): Promise<T> {
  const database = await createTempDatabase(options);
  try {
    return await fn(database);
  } finally {
    await database.drop();
  }
}

async function withAdminPool<T>(
  url: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
