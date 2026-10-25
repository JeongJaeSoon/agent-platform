import * as schema from "@werft-ai/db";
import {
  announceLapsedInputWaits,
  expireAuthzDecisions,
  expireOverdueInterrupts,
  expireOverdueTerminations,
  projectToolCalls,
  reconcileExpiredLeases,
  reconcileOrphanedSessions,
  reconcileOverdueInterrupts,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger, logLevelFromEnv } from "@werft-ai/observability";
import {
  INTERRUPT_RECEIPT_DEADLINE_MS,
  INTERRUPT_SETTLE_DEADLINE_MS,
  TERMINATE_DEADLINE_MS,
} from "@werft-ai/platform";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  type ReconcilerLogger,
  type ReconcilerRun,
  runReconciler,
} from "./reconcile.ts";

// From packages/db/bench/tool-calls.ts on 18M events: a batch of results
// alone took 4s at 20,000 and up to 99s while backfill writes piled up. The
// pass (RECONCILER_PASS_TIMEOUT_SEC, 60) must also fit this budget plus the
// last batch's statements, each cut at the job pool's 10s.
const TOOL_CALL_BATCH_SIZE = 5_000;
const TOOL_CALL_BUDGET_MS = 10_000;

export function reconcilerDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const databaseUrl =
    environment.DATABASE_URL || environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  return databaseUrl;
}

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const databaseUrl = reconcilerDatabaseUrl(environment);
  const logger = createLogger({
    level: logLevelFromEnv(environment.LOG_LEVEL),
  });
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
    expireInterrupts: (options) =>
      expireOverdueInterrupts(db, {
        ...options,
        deadlineMs: INTERRUPT_RECEIPT_DEADLINE_MS,
        logger,
      }),
    expireTerminations: (options) =>
      expireOverdueTerminations(db, {
        ...options,
        deadlineMs: TERMINATE_DEADLINE_MS,
        logger,
      }),
    announceInputReturns: (options) => announceLapsedInputWaits(db, options),
    expireDecisions: (options) => expireAuthzDecisions(db, options),
    projectToolCalls: () =>
      projectToolCalls(db, {
        batchSize: TOOL_CALL_BATCH_SIZE,
        budgetMs: TOOL_CALL_BUDGET_MS,
      }),
  });
}
