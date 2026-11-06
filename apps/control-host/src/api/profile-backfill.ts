import * as schema from "@werft-ai/db";
import { createPostgresProfileRolloutStore } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { drizzle } from "drizzle-orm/node-postgres";

const USAGE = "usage: profile-backfill [--apply]";

/**
 * The one-time fill before profile rollouts are written (design 2.3, 2.6):
 * agents on an older profile form become `pinned`, and fixed-model agents
 * that run their profile's default model follow it. Without `--apply` it only
 * prints what it would do. Run it once; a real run is refused after the first
 * rollout exists. Exit 0: done (or a dry run); 1: refused.
 */
export async function profileBackfill(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log,
): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--apply");
  if (unknown.length > 0)
    throw new Error(`unknown option ${unknown[0]}\n${USAGE}`);
  const databaseUrl =
    environment.DATABASE_URL || environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  const logger = createLogger({ level: "warn" });
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    "profile-backfill",
    JOB_POOL_TIMEOUTS,
    { max: 2 },
  );
  try {
    const store = createPostgresProfileRolloutStore(drizzle(pool, { schema }));
    const report = await store.backfill({ dryRun: !argv.includes("--apply") });
    if ("refused" in report) {
      out(JSON.stringify({ refused: report.refused }));
      return 1;
    }
    out(
      JSON.stringify({
        dry_run: report.dryRun,
        pinned: { count: report.pinned.length, agents: report.pinned },
        model_follows_profile: {
          count: report.modelFollowsProfile.length,
          agents: report.modelFollowsProfile,
        },
      }),
    );
    return 0;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await profileBackfill(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
