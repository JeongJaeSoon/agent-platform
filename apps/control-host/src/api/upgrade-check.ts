import * as schema from "@werft-ai/db";
import { listUncollectedSessionPointers } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger, type StructuredLogger } from "@werft-ai/observability";
import {
  assessUpgrade,
  type UpgradeSession,
  type WorkerImagesEnvironment,
  workerImageRuntimesFromEnv,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";

export type UpgradeCheckEnvironment = Readonly<
  Record<string, string | undefined>
> &
  WorkerImagesEnvironment & {
    DATABASE_URL?: string | undefined;
    UPGRADE_APPROVED_SESSIONS?: string | undefined;
    UPGRADE_DEPLOYED_WORKER_IMAGE?: string | undefined;
    WORKER_IMAGE?: string | undefined;
    WORKER_IMAGE_PREVIOUS?: string | undefined;
  };

export const UPGRADE_CHECK_EXIT = {
  proceed: 0,
  check_failed: 1,
  refused: 2,
} as const;

/**
 * The pre-upgrade check (helm hook `upgrade-check`, or by hand before a
 * `helm rollback`): reads every session holding an uncollected checkpoint
 * and prints one JSON line saying whether the target release's worker
 * images leave any of them with nothing to resume on.
 *
 * Read: `DATABASE_URL`; the target's `WORKER_IMAGE`, `WORKER_IMAGE_RUNTIME`,
 * `WORKER_IMAGE_PREVIOUS`, `WORKER_IMAGE_PREVIOUS_RUNTIME`; the
 * `UPGRADE_DEPLOYED_WORKER_IMAGE` the cluster runs now; and
 * `UPGRADE_APPROVED_SESSIONS`, a JSON array of session ids.
 *
 * Returns the exit code: 0 proceed, 2 refused, 1 when the check could not
 * be made (a setting missing or unreadable, the database unreachable),
 * which stops the upgrade as surely as a refusal: there is no override.
 */
export async function runUpgradeCheck(input: {
  environment: UpgradeCheckEnvironment;
  logger: StructuredLogger;
  /** Tests substitute the database; the product path connects to it. */
  listSessions?: (databaseUrl: string) => Promise<readonly UpgradeSession[]>;
  write?: (line: string) => void;
}): Promise<number> {
  const { environment } = input;
  const write = input.write ?? ((line: string) => console.log(line));
  const base = {
    deployedWorker: environment.UPGRADE_DEPLOYED_WORKER_IMAGE || null,
    targetWorker: environment.WORKER_IMAGE || null,
    targetPreviousWorker: environment.WORKER_IMAGE_PREVIOUS || null,
  };
  const failed = (reason: string) => {
    write(
      JSON.stringify({
        verdict: "check_failed",
        ...base,
        affected: [],
        approved: [],
        reason,
      }),
    );
    return UPGRADE_CHECK_EXIT.check_failed;
  };

  let settings: ReturnType<typeof readSettings>;
  try {
    settings = readSettings(environment);
  } catch (error) {
    return failed((error as Error).message);
  }

  let sessions: readonly UpgradeSession[];
  try {
    sessions = await (input.listSessions ?? listSessions(input.logger))(
      settings.databaseUrl,
    );
  } catch (error) {
    // drizzle wraps the driver's error, which says why, as the cause.
    const cause = (error as Error).cause;
    return failed(
      `could not read sessions: ${cause instanceof Error ? cause.message : (error as Error).message}`,
    );
  }

  const assessment = assessUpgrade({ ...settings, sessions });
  write(JSON.stringify({ ...base, ...assessment }));
  return UPGRADE_CHECK_EXIT[assessment.verdict];
}

function readSettings(environment: UpgradeCheckEnvironment) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const targetWorker = environment.WORKER_IMAGE;
  if (!targetWorker) throw new Error("WORKER_IMAGE is not set");
  const deployedWorker = environment.UPGRADE_DEPLOYED_WORKER_IMAGE;
  if (!deployedWorker) {
    throw new Error(
      "UPGRADE_DEPLOYED_WORKER_IMAGE is empty: the deployed worker image could not be read (a dry run or `helm template` reads no cluster)",
    );
  }
  const runtimes = workerImageRuntimesFromEnv(environment);
  if (runtimes === null) throw new Error("WORKER_IMAGE_RUNTIME is not set");
  const targetPreviousWorker = environment.WORKER_IMAGE_PREVIOUS || null;
  if ((targetPreviousWorker === null) !== (runtimes.previous === null)) {
    throw new Error(
      "WORKER_IMAGE_PREVIOUS and WORKER_IMAGE_PREVIOUS_RUNTIME go together",
    );
  }
  return {
    databaseUrl,
    targetWorker,
    deployedWorker,
    targetPreviousWorker,
    runtimes,
    approved: approvedSessions(environment.UPGRADE_APPROVED_SESSIONS ?? "[]"),
  };
}

function approvedSessions(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("UPGRADE_APPROVED_SESSIONS is not JSON");
  }
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === "string" && id !== "")
  ) {
    throw new Error(
      "UPGRADE_APPROVED_SESSIONS must be a JSON array of session ids",
    );
  }
  return value;
}

function listSessions(logger: StructuredLogger) {
  return async (databaseUrl: string) => {
    const pool = createEnforcedPool(
      databaseUrl,
      logger,
      "upgrade-check",
      JOB_POOL_TIMEOUTS,
    );
    try {
      return await listUncollectedSessionPointers(drizzle(pool, { schema }));
    } finally {
      await pool.end();
    }
  };
}

if (import.meta.main) {
  const logger = createLogger(
    process.env.LOG_LEVEL === undefined ? {} : { level: process.env.LOG_LEVEL },
  );
  process.exit(await runUpgradeCheck({ environment: process.env, logger }));
}
