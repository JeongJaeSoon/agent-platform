import * as schema from "@claude-session-platform/db";
import { reconcileOrphanedSessions } from "@claude-session-platform/db";
import { createLogger } from "@claude-session-platform/observability";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runReconciler } from "./reconcile.ts";

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const databaseUrl =
    environment.DATABASE_URL ?? environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  const logger = createLogger(
    environment.LOG_LEVEL === undefined ? {} : { level: environment.LOG_LEVEL },
  );
  try {
    await runReconciler({
      environment: {
        ...(environment.HEARTBEAT_TTL_SEC === undefined
          ? {}
          : { HEARTBEAT_TTL_SEC: environment.HEARTBEAT_TTL_SEC }),
        ...(environment.RECONCILER_BATCH_SIZE === undefined
          ? {}
          : { RECONCILER_BATCH_SIZE: environment.RECONCILER_BATCH_SIZE }),
        ...(environment.RECONCILER_DRY_RUN === undefined
          ? {}
          : { RECONCILER_DRY_RUN: environment.RECONCILER_DRY_RUN }),
      },
      logger,
      reconcile: (options) => reconcileOrphanedSessions(db, options),
    });
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
