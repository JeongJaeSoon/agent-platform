import * as schema from "@werft-ai/db";
import {
  type ArchiveObjectStore,
  archiveSessionEvents,
  type Database,
  restoreSessionEvents,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger, type StructuredLogger } from "@werft-ai/observability";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
} from "@werft-ai/storage";
import { drizzle } from "drizzle-orm/node-postgres";
import { booleanFlag } from "../boolean-flag.ts";
import {
  assertCheckpointBucketProtection,
  type CheckpointStorageEnvironment,
  checkpointStorageConfigFromEnv,
} from "./checkpoints.ts";

const BATCH_SIZE = 100;
export const DEFAULT_SESSION_ARCHIVE_AFTER_DAYS = 180;
const MIN_AFTER_DAYS = 30;
const MAX_AFTER_DAYS = 3650;

/** `0` turns archiving off; otherwise a whole number of days, 30–3650. */
export function sessionArchiveAfterDays(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_SESSION_ARCHIVE_AFTER_DAYS;
  }
  const days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (days === 0) return 0;
  if (!(days >= MIN_AFTER_DAYS && days <= MAX_AFTER_DAYS)) {
    throw new Error(
      `SESSION_ARCHIVE_AFTER_DAYS must be 0 (off) or a whole number of days from ${MIN_AFTER_DAYS} to ${MAX_AFTER_DAYS}, got "${value}"`,
    );
  }
  return days;
}

type Stores = {
  db: Database;
  objects: ArchiveObjectStore;
  close(): Promise<void>;
};

/**
 * One archiving pass, then exit, on the API image with the API's object
 * store settings: moves `events` of sessions idle longer than
 * `SESSION_ARCHIVE_AFTER_DAYS` into held objects under `session-archive/`.
 * `SESSION_ARCHIVE_DRY_RUN` defaults to true, which only counts.
 *
 * `restore <session id>` puts that session's archived events back instead.
 *
 * Only a `locked` deployment archives: the held version is what makes the
 * object a safe place for rows the database then deletes. Returns the exit
 * code: 1 when any session failed.
 */
export async function runSessionArchive(input: {
  argv?: readonly string[];
  environment: CheckpointStorageEnvironment & {
    DATABASE_URL?: string;
    SESSION_ARCHIVE_AFTER_DAYS?: string;
    SESSION_ARCHIVE_DRY_RUN?: string;
  };
  logger: StructuredLogger;
  /** Tests substitute the stores; the product path builds them from env. */
  connect?: (config: {
    bucket: string;
    databaseUrl: string;
  }) => Promise<Stores>;
}): Promise<number> {
  const { environment, logger } = input;
  const [command, sessionId, ...rest] = input.argv ?? [];
  if (
    (command !== undefined && command !== "restore") ||
    (command === "restore" && (sessionId === undefined || rest.length > 0))
  ) {
    throw new Error("Usage: session-archive.ts [restore <session id>]");
  }
  const afterDays = sessionArchiveAfterDays(
    environment.SESSION_ARCHIVE_AFTER_DAYS,
  );
  const dryRun = booleanFlag(
    environment.SESSION_ARCHIVE_DRY_RUN ?? "true",
    "SESSION_ARCHIVE_DRY_RUN",
  );
  const config = checkpointStorageConfigFromEnv(environment);
  if (config === "disabled" || config.protection !== "locked") {
    const reason =
      config === "disabled"
        ? "CHECKPOINT_OBJECT_STORE=disabled"
        : "CHECKPOINT_OBJECT_PROTECTION=unversioned cannot hold archived events";
    if (command === "restore") {
      throw new Error(`Cannot restore archived events: ${reason}`);
    }
    logger.info("Session archive skipped", { reason });
    return 0;
  }
  if (command === undefined && afterDays === 0) {
    logger.info("Session archive skipped", {
      reason: "SESSION_ARCHIVE_AFTER_DAYS=0",
    });
    return 0;
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const stores = await (input.connect ?? connect(config, logger))({
    bucket: config.bucket,
    databaseUrl,
  });
  try {
    if (command === "restore" && sessionId !== undefined) {
      const restored = await restoreSessionEvents(
        stores.db,
        stores.objects,
        sessionId,
      );
      logger.info("Session archive restored", {
        session_id: sessionId,
        ...restored,
      });
      return 0;
    }
    const totals = await archiveSessionEvents(stores.db, stores.objects, {
      afterDays,
      batchSize: BATCH_SIZE,
      dryRun,
      onSession(id, result) {
        if (result.status === "failed") {
          logger.error("Session archive failed for a session", {
            error: String(result.error),
            session_id: id,
          });
        } else if (result.events > 0) {
          logger.info(
            dryRun
              ? "Session archive would move a session"
              : "Session archive moved a session",
            { session_id: id, ...withoutStatus(result) },
          );
        }
      },
    });
    logger.info("Session archive completed", {
      after_days: afterDays,
      dry_run: dryRun,
      ...totals,
    });
    return totals.failed > 0 ? 1 : 0;
  } finally {
    await stores.close();
  }
}

function withoutStatus<T extends { status: string }>({
  status: _,
  ...rest
}: T) {
  return rest;
}

function connect(
  config: Exclude<
    ReturnType<typeof checkpointStorageConfigFromEnv>,
    "disabled"
  >,
  logger: StructuredLogger,
) {
  return async ({
    bucket,
    databaseUrl,
  }: {
    bucket: string;
    databaseUrl: string;
  }): Promise<Stores> => {
    await assertCheckpointBucketProtection(config);
    const pool = createEnforcedPool(
      databaseUrl,
      logger,
      "session-archive",
      JOB_POOL_TIMEOUTS,
    );
    const client = createStorageS3Client({ s3: config });
    const objects = createCheckpointObjectStore({ bucket, client });
    const hold = objects.hold?.bind(objects);
    if (hold === undefined) {
      throw new Error("The checkpoint object store cannot hold versions");
    }
    return {
      db: drizzle(pool, { schema }),
      objects: {
        get: (key, version) => objects.get(key, version),
        hold,
        putImmutable: (key, body) => objects.putImmutable(key, body),
      },
      async close() {
        client.destroy();
        await pool.end();
      },
    };
  };
}

if (import.meta.main) {
  const logger = createLogger(
    process.env.LOG_LEVEL === undefined ? {} : { level: process.env.LOG_LEVEL },
  );
  process.exit(
    await runSessionArchive({
      argv: process.argv.slice(2),
      environment: process.env,
      logger,
    }),
  );
}
