import * as schema from "@werft-ai/db";
import { forgetLostCheckpoints, hasUncollectedCheckpoint } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  checkpointStorageConfigFromEnv,
  forgetLostCheckpointObjects,
} from "./checkpoints.ts";

/**
 * Gives up the checkpoints an emptied bucket lost, so the API starts again
 * without a reset (forgetLostCheckpointObjects, forgetLostCheckpoints). A
 * one-shot on the API image with the API's object store settings and
 * `DATABASE_URL`, run while the API is down: `scripts/local.sh
 * forget-lost-checkpoints`. Prints what was lost, one session per line.
 */
async function main(): Promise<void> {
  const config = checkpointStorageConfigFromEnv(process.env);
  if (config === "disabled") {
    throw new Error(
      "CHECKPOINT_OBJECT_STORE=disabled stores no checkpoint objects to lose",
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createEnforcedPool(
    databaseUrl,
    createLogger(),
    "forget-lost-checkpoints",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const db = drizzle(pool, { schema });
    const lost = await forgetLostCheckpointObjects(config, {
      hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
      forget: () => forgetLostCheckpoints(db, new Date()),
    });
    const total = lost.held.length + lost.unchanged.length;
    if (total === 0) {
      console.log(
        "No checkpoint is missing from the bucket; nothing to forget",
      );
      return;
    }
    console.log(
      `Lost the checkpoints of ${total} session(s): ${lost.held.length} now wait in recovery_required (resume refuses; decide start_fresh or close), ${lost.unchanged.length} keep their state`,
    );
    for (const id of lost.held) console.log(`recovery_required ${id}`);
    for (const id of lost.unchanged) console.log(`unchanged ${id}`);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
