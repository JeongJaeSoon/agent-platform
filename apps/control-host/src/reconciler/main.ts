import * as schema from "@agent-platform/db";
import {
  announceLapsedInputWaits,
  expireOverdueInterrupts,
  expireOverdueTerminations,
  reconcileExpiredLeases,
  reconcileOrphanedSessions,
  reconcileOverdueInterrupts,
} from "@agent-platform/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@agent-platform/db/pool";
import { createLogger } from "@agent-platform/observability";
import {
  INTERRUPT_RECEIPT_DEADLINE_MS,
  INTERRUPT_SETTLE_DEADLINE_MS,
  TERMINATE_DEADLINE_MS,
} from "@agent-platform/platform";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  type ReconcilerLogger,
  type ReconcilerRun,
  runReconciler,
} from "./reconcile.ts";

export function reconcilerDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const databaseUrl =
    environment.DATABASE_URL ?? environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  return databaseUrl;
}

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const databaseUrl = reconcilerDatabaseUrl(environment);
  const logger = createLogger(
    environment.LOG_LEVEL === undefined ? {} : { level: environment.LOG_LEVEL },
  );
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    "reconciler",
    JOB_POOL_TIMEOUTS,
  );
  try {
    await reconcileOnce(drizzle(pool, { schema }), environment, logger);
  } finally {
    await pool.end();
  }
}

/** One pass over `db`; every write in it is re-judged under row locks. */
export function reconcileOnce(
  db: NodePgDatabase<typeof schema>,
  environment: NodeJS.ProcessEnv,
  logger: ReconcilerLogger,
): Promise<ReconcilerRun> {
  return runReconciler({
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
    expireInterrupts: ({ dryRun, now }) =>
      expireOverdueInterrupts(db, {
        deadlineMs: INTERRUPT_RECEIPT_DEADLINE_MS,
        dryRun,
        now,
      }),
    expireTerminations: ({ dryRun, now }) =>
      expireOverdueTerminations(db, {
        deadlineMs: TERMINATE_DEADLINE_MS,
        dryRun,
        now,
      }),
    announceInputReturns: (options) => announceLapsedInputWaits(db, options),
  });
}
