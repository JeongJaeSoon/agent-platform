import * as schema from "@agent-platform/db";
import {
  expireOverdueTerminations,
  reconcileExpiredLeases,
  reconcileOrphanedSessions,
  reconcileOverdueInterrupts,
} from "@agent-platform/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@agent-platform/db/pool";
import { createLogger } from "@agent-platform/observability";
import {
  INTERRUPT_SETTLE_DEADLINE_MS,
  TERMINATE_DEADLINE_MS,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { runReconciler } from "./reconcile.ts";

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const databaseUrl =
    environment.DATABASE_URL ?? environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  const logger = createLogger(
    environment.LOG_LEVEL === undefined ? {} : { level: environment.LOG_LEVEL },
  );
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    "reconciler",
    JOB_POOL_TIMEOUTS,
  );
  const db = drizzle(pool, { schema });
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
      reconcileLeases: (options) => reconcileExpiredLeases(db, options),
      reconcileInterrupts: (options) =>
        reconcileOverdueInterrupts(db, {
          ...options,
          deadlineMs: INTERRUPT_SETTLE_DEADLINE_MS,
        }),
      expireTerminations: ({ dryRun, now }) =>
        expireOverdueTerminations(db, {
          deadlineMs: TERMINATE_DEADLINE_MS,
          dryRun,
          now,
        }),
    });
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
