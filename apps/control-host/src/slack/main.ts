import { integerSetting } from "@werft-ai/contracts/settings";
import * as schema from "@werft-ai/db";
import { createPostgresSlackInboundEventStore } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger, logLevelFromEnv } from "@werft-ai/observability";
import {
  drainSlackInbox,
  noopSlackInboundHandler,
  type SessionCatalogConfig,
  type SlackInboxDrain,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  DEFAULT_CONFIG_DIR,
  loadCatalogConfig,
  loadSecretKey,
  type SecretReader,
  secretsManagerReader,
} from "../api/catalog-config.ts";
import { PASS_LOOP_ROLES, passLoopConfigFromEnv } from "../pass-loop/loop.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function slackDatabaseUrl(environment: Environment): string {
  const databaseUrl =
    environment.DATABASE_URL || environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  return databaseUrl;
}

export function slackRoleSettings(environment: Environment): {
  batchSize: number;
  leaseMs: number;
  passBudgetMs: number;
} {
  const { passTimeoutMs } = passLoopConfigFromEnv(
    environment,
    PASS_LOOP_ROLES.slack,
  );
  return {
    batchSize: integerSetting(environment, "SLACK_ROLE_BATCH_SIZE", {
      min: 1,
      default: 10,
    }),
    leaseMs:
      integerSetting(environment, "SLACK_ROLE_LEASE_SEC", {
        min: 1,
        default: 60,
      }) * 1000,
    passBudgetMs: passTimeoutMs / 2,
  };
}

/**
 * Checked once before the first pass: settings, database URL, the catalog
 * under the api's rules but without its credentials, and the master key.
 */
export async function slackRoleStartup(
  environment: Environment,
  readSecret: SecretReader = secretsManagerReader(environment),
): Promise<{ catalog: SessionCatalogConfig; secretKeySet: boolean }> {
  slackRoleSettings(environment);
  slackDatabaseUrl(environment);
  const dir = environment.PLATFORM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  const catalog = await loadCatalogConfig({ dir, env: environment });
  const secretKey = await loadSecretKey({ dir, env: environment, readSecret });
  return { catalog, secretKeySet: secretKey !== null };
}

export async function main(
  environment: Environment = process.env,
): Promise<SlackInboxDrain> {
  const settings = slackRoleSettings(environment);
  const logger = createLogger({
    level: logLevelFromEnv(environment.LOG_LEVEL),
  });
  const pool = createEnforcedPool(
    slackDatabaseUrl(environment),
    logger,
    "slack",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const drain = await drainSlackInbox({
      inbox: createPostgresSlackInboundEventStore(drizzle(pool, { schema })),
      handler: noopSlackInboundHandler,
      logger,
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      deadline: Date.now() + settings.passBudgetMs,
    });
    if (drain.claimed > 0) logger.info("Slack inbox pass", drain);
    return drain;
  } finally {
    await pool.end();
  }
}
