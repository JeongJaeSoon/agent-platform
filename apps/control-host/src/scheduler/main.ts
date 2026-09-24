import * as schema from "@agent-platform/db";
import { createPostgresSchedulerStore } from "@agent-platform/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@agent-platform/db/pool";
import { LocalDockerBackend } from "@agent-platform/execution-local-docker";
import { createLogger } from "@agent-platform/observability";
import {
  reclaimNetworks,
  reclaimWorkspaces,
  runScheduler,
  type SchedulerRunSummary,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { PASS_DEGRADED_EXIT, PASS_SKIPPED_EXIT } from "../pass-loop/loop.ts";
import { schedulerConfigFromEnv } from "./config.ts";
import { latchOnConnectionLoss } from "./connection-latch.ts";
import {
  QUOTA_PREFLIGHT_MARKER_ENV,
  verifyWorkspaceQuotaOnce,
} from "./quota-preflight.ts";

/**
 * One scheduling pass (`main.ts scheduler --once`); the scheduler role runs
 * it under the pass loop. This is the only process that holds the Docker
 * socket; worker containers never see it. `stop` ends the pass at its next
 * safe point.
 */
export async function main(
  environment: NodeJS.ProcessEnv = process.env,
  options: { stop?: AbortSignal } = {},
): Promise<SchedulerRunSummary> {
  const config = schedulerConfigFromEnv(environment);
  const logger = createLogger(
    config.logLevel === undefined ? {} : { level: config.logLevel },
  );
  // The pass-lock client comes out of this pool too, so a frozen database
  // fails the lock query as well instead of holding the pass open.
  const pool = createEnforcedPool(
    config.databaseUrl,
    logger,
    "scheduler",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const db = drizzle(pool, { schema });
    const backend = new LocalDockerBackend(config.docker);
    if (config.docker.workspaceQuota.mode === "off") {
      // The one warning the opt-out costs. Losing the quota by accident —
      // a daemon that cannot carry one — stops the process instead.
      logger.warn(
        "Worker workspaces have no disk or inode quota (EXECUTION_WORKSPACE_QUOTA=off); " +
          "a runaway worker can fill this daemon's disk or exhaust its inodes",
      );
    }
    const latch = latchOnConnectionLoss(
      createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
        sessionCostLimitUsd: config.limits.sessionCostLimitUsd,
      }),
      (error) => {
        logger.error("Database connection lost; failing the rest of the pass", {
          error: messageOf(error),
        });
      },
    );
    const store = latch.store;
    // Before anything is launched: without exactly one running proxy there
    // is nothing to give a worker network, and a daemon older than Docker 28
    // cannot keep the host off one. The network reconcile still runs,
    // under the pass lock like the pass itself, since two running proxies are
    // exactly when it has to take them off the live networks; the error is
    // rethrown either way.
    try {
      await backend.verifyNetworkIsolation();
    } catch (error) {
      logger.error(
        "Network isolation preflight failed; reconciling worker networks before giving up",
        { error: messageOf(error) },
      );
      await reclaimNetworks({ backend, logger, store }).catch(
        (reconcileError: unknown) => {
          logger.error("Worker network reconcile failed", {
            error: messageOf(reconcileError),
          });
        },
      );
      throw error;
    }
    await verifyWorkspaceQuotaOnce({
      logger,
      marker: environment[QUOTA_PREFLIGHT_MARKER_ENV],
      // Any setting, not just the quota's: a new daemon or installation id
      // is as much a reason to probe again.
      settings: config.docker,
      verify: async () => {
        try {
          await backend.verifyWorkspaceQuota();
        } catch (error) {
          // The probe needs a little disk of its own, so a daemon that is
          // already full fails it — and that is exactly when the workspaces
          // of finished sessions are worth reclaiming. `reclaimWorkspaces`
          // frees them without starting or replacing anything, which a pass
          // with no free slots would still do; the error is rethrown
          // afterwards, so this process refuses to admit work either way.
          logger.error(
            "Workspace quota preflight failed; reclaiming workspaces before giving up",
            { error: messageOf(error) },
          );
          await reclaimWorkspaces({
            backend,
            logger,
            stoppedWorkspaceTtlMs: config.stoppedWorkspaceTtlMs,
            store,
          }).catch((reclaimError: unknown) => {
            logger.error("Workspace reclaim failed", {
              error: messageOf(reclaimError),
            });
          });
          throw error;
        }
      },
    });
    const summary = await runScheduler({
      backend,
      drainDeadlineMs: config.drainDeadlineMs,
      image: config.image,
      logger,
      resources: config.resources,
      slotLimit: config.slotLimit,
      stoppedWorkspaceTtlMs: config.stoppedWorkspaceTtlMs,
      store,
      ...(options.stop === undefined ? {} : { stop: options.stop }),
    });
    // The pass records a lost connection against each execution it was
    // reconciling and can still come back with a summary; the database being
    // gone is the process's failure, not theirs.
    const lost = latch.lost();
    if (lost !== undefined) throw lost;
    return summary;
  } finally {
    await pool.end();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Non-zero when the pass left work undone, so the pass loop notices. A pass
 * that found the lock held did nothing and says so (PASS_SKIPPED_EXIT). One
 * that did everything it could but left a session it cannot help this pass
 * says that instead (PASS_DEGRADED_EXIT, 94S-368), unless something else
 * failed too.
 */
export function exitCodeFor(summary: SchedulerRunSummary): number {
  if (summary.skipped) return PASS_SKIPPED_EXIT;
  if (
    summary.failedLaunches.length > 0 ||
    summary.imageUnresolved ||
    summary.killFailed.length > 0 ||
    // A network that could be neither removed nor repaired is a leaked
    // address pool or a worker without egress; both need someone to look.
    summary.networkScanFailed ||
    summary.networksFailed.length > 0 ||
    summary.orphansUnresolved.length > 0 ||
    summary.reclaimFailed.length > 0 ||
    summary.reconcileFailed.length > 0 ||
    // A GC fault, not a GC judgement: `workspacesUnresolved` is deliberate
    // and stays out of this, but a scan or a removal that threw means disk
    // is being left behind for a reason nobody has looked at.
    summary.workspaceScanFailed ||
    summary.workspacesFailed.length > 0
  ) {
    return 1;
  }
  // A launch waiting out its backoff is one that is failing; one given up
  // on failed its session's input; so did a session out of replacements.
  // Each is one session's trouble, kept in the database, that a restart of
  // this loop would not fix.
  return summary.launchesBackingOff.length > 0 ||
    summary.launchesQuarantined.length > 0 ||
    summary.replacementsExhausted.length > 0
    ? PASS_DEGRADED_EXIT
    : 0;
}
