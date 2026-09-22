import * as schema from "@agent-platform/db";
import { createPostgresSchedulerStore } from "@agent-platform/db";
import { LocalDockerBackend } from "@agent-platform/execution-local-docker";
import { createLogger } from "@agent-platform/observability";
import {
  runScheduler,
  type SchedulerRunSummary,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schedulerConfigFromEnv } from "./config.ts";

/**
 * One scheduling pass, then exit: the same shape as `apps/reconciler`. This
 * is the only process that holds the Docker socket; worker containers never
 * see it. Moves into the control host with 94S-117.
 */
export async function main(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SchedulerRunSummary> {
  const config = schedulerConfigFromEnv(environment);
  const logger = createLogger(
    config.logLevel === undefined ? {} : { level: config.logLevel },
  );
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const db = drizzle(pool, { schema });
    const backend = new LocalDockerBackend(config.docker);
    // Before anything is launched: the egress policy is only worth what the
    // worker network's `internal` flag is worth, and only the daemon knows.
    await backend.verifyNetworkIsolation();
    return await runScheduler({
      backend,
      image: config.image,
      logger,
      resources: config.resources,
      slotLimit: config.slotLimit,
      store: createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
      }),
    });
  } finally {
    await pool.end();
  }
}

/** Non-zero when the pass left work undone, so cron/supervisors notice. */
export function exitCodeFor(summary: SchedulerRunSummary): number {
  return summary.failedLaunches.length > 0 ||
    summary.orphansUnresolved.length > 0 ||
    summary.reclaimFailed.length > 0 ||
    summary.reconcileFailed.length > 0
    ? 1
    : 0;
}

if (import.meta.main) {
  process.exitCode = exitCodeFor(await main());
}
