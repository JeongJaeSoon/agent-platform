import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const migrationsFolder = join(import.meta.dir, "..", "..", "db", "migrations");

let migrated: Promise<Blob> | undefined;

/**
 * A fresh in-memory PGlite with every migration applied, as if it had been
 * created and migrated on the spot. Starting one and running the migrations
 * costs about a second on a CI runner; loading the data directory of one
 * migrated earlier in this process costs a tenth of that, so the migrations
 * run once per `bun test` process and every caller gets its own copy.
 */
export async function migratedPGlite(): Promise<PGlite> {
  migrated ??= (async () => {
    const base = new PGlite();
    try {
      await migrate(drizzle(base), { migrationsFolder });
      return await base.dumpDataDir("none");
    } finally {
      await base.close();
    }
  })();
  const client = new PGlite({ loadDataDir: await migrated });
  await client.waitReady;
  return client;
}
