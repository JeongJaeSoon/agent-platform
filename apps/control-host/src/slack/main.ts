import { integerSetting } from "@werft-ai/contracts/settings";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresInstallationProfileStore,
  createPostgresLinkedAccountStore,
  createPostgresSecretStore,
  createPostgresSessionControl,
  createPostgresSessionLinkStore,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionUnitOfWork,
  createPostgresSlackAppStore,
  createPostgresSlackGuestSetting,
  createPostgresSlackInboundEventStore,
  createPostgresSlackOutboxStore,
  createPostgresSurfaceBindingStore,
  createPostgresWorkspaceProfileStore,
  type Database,
  getSlackAppSettings,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import {
  createLogger,
  logLevelFromEnv,
  type StructuredLogger,
} from "@werft-ai/observability";
import {
  allowedRun,
  type Connections,
  createAuthorizationPolicy,
  createLoggingSlackNoticeSink,
  createOutboxSlackNoticeSink,
  createProfileRegistry,
  createSessionService,
  createSlackBotApi,
  createSlackMemberJoinedHandler,
  createSlackSessionHandler,
  createSlackWelcome,
  drainSlackInbox,
  drainSlackOutbox,
  installationLimitsFromEnv,
  profileCatalog,
  resolveAgentRelease,
  type SecretKey,
  type SessionCatalogConfig,
  type SlackInboundEventStore,
  type SlackInboundHandler,
  type SlackInboxDrain,
  type SlackNoticeSink,
  sessionCatalogView,
  slackBotToken,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  DEFAULT_CONFIG_DIR,
  loadCatalogConfig,
  loadSecretKey,
  profileViewSources,
  readConnections,
  SECRET_KEY_SETTING,
  type SecretReader,
  secretsManagerReader,
} from "../api/catalog-config.ts";
import { eventNeutralizer } from "../api/neutral-fields.ts";
import { consoleOriginFrom, slackApiUrlFrom } from "../api/slack-config.ts";
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
): Promise<{
  catalog: SessionCatalogConfig;
  connections: Connections;
  secretKeySet: boolean;
  secretKey: SecretKey | null;
}> {
  slackRoleSettings(environment);
  slackDatabaseUrl(environment);
  const dir = environment.PLATFORM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  const catalog = await loadCatalogConfig({ dir, env: environment });
  const connections = await readConnections(dir);
  const secretKey = await loadSecretKey({ dir, env: environment, readSecret });
  return {
    catalog,
    connections,
    secretKeySet: secretKey !== null,
    secretKey,
  };
}

/**
 * The api's registry without credentials: the slack role imports nothing,
 * it reads what the api imported.
 */
export function slackProfileCatalog(
  db: Database,
  config: SessionCatalogConfig,
  connections: Connections,
  environment: Environment,
) {
  return profileCatalog(
    sessionCatalogView(config),
    createProfileRegistry({
      workspaces: createPostgresWorkspaceProfileStore(db),
      installations: createPostgresInstallationProfileStore(db),
      sources: profileViewSources(
        connections,
        config.repositories,
        environment,
      ),
    }),
  );
}

export function slackSessionHandler(deps: {
  db: Database;
  pool: Pick<Pool, "connect">;
  environment: Environment;
  logger: StructuredLogger;
  catalog: SessionCatalogConfig;
  connections: Connections;
  /** Null without a master key: an event that needs a bot token waits. */
  secretKey: SecretKey | null;
  leaseMs: number;
  notices?: SlackNoticeSink;
  slackApiUrl?: string;
  inbox?: Pick<SlackInboundEventStore, "renew">;
  /**
   * The pass's catalog, already read. No timer reads it again: the pass
   * child outlives the pass, and lookups of an unread id read it themselves.
   */
  profiles?: ReturnType<typeof slackProfileCatalog>;
}): SlackInboundHandler {
  const { db, environment, logger } = deps;
  const catalog =
    deps.profiles ??
    slackProfileCatalog(db, deps.catalog, deps.connections, environment);
  const credentials = createPostgresCredentialBindingStore(db);
  const authorization = createAuthorizationPolicy({
    identity: createDatabaseIdentityReader(db),
    agents: createDatabaseAgentAuthority(db),
    credentials,
    slackGuests: createPostgresSlackGuestSetting(db),
    sessions: createPostgresSessionShareStore(db),
    decisions: createPostgresDecisionLog(db),
  });
  const agentStore = createPostgresAgentStore(db);
  const sessions = createSessionService({
    authorization,
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db, {
      connect: () => deps.pool.connect(),
      logger,
    }),
    reader: createPostgresSessionReader(db, {
      logger,
      neutralize: eventNeutralizer(catalog, logger),
    }),
    catalog,
    releases: {
      resolveRelease: (workspaceId, releaseId) =>
        resolveAgentRelease(
          { store: agentStore, catalog },
          workspaceId,
          releaseId,
        ),
    },
    credentials,
    limits: installationLimitsFromEnv(environment),
  });
  const { secretKey } = deps;
  const secrets =
    secretKey === null ? null : createPostgresSecretStore(db, secretKey);
  const consoleOrigin = consoleOriginFrom(environment);
  const identities = createPostgresAgentIdentityStore(db);
  const bindings = createPostgresSurfaceBindingStore(db);
  const sessionHandler = createSlackSessionHandler({
    inbox: deps.inbox ?? createPostgresSlackInboundEventStore(db),
    leaseMs: deps.leaseMs,
    authorization,
    agents: identities,
    links: createPostgresLinkedAccountStore(db),
    bindings,
    settings: {
      getSettings: (workspaceId, agentId) =>
        getSlackAppSettings(db, workspaceId, agentId),
    },
    sessionLinks: createPostgresSessionLinkStore(db),
    sessions,
    agentDetails: agentStore,
    releaseRepositoryUnusable: async (workspaceId, releaseId) => {
      const release = await agentStore.findRelease(workspaceId, releaseId);
      return (
        release !== null &&
        allowedRun(
          catalog,
          release.runtime_profile_id,
          release.repository_id,
        ) === null
      );
    },
    slack: createSlackBotApi({
      apiUrl: deps.slackApiUrl ?? slackApiUrlFrom(environment),
    }),
    botToken: async (workspaceId, slackAppId) => {
      if (secrets === null) {
        throw new Error(`${SECRET_KEY_SETTING} is unset: no bot token opens`);
      }
      return slackBotToken(secrets, workspaceId, slackAppId);
    },
    notices: deps.notices ?? createLoggingSlackNoticeSink(logger),
    logger,
    connectUrl:
      consoleOrigin === null
        ? ""
        : new URL("/settings/linked-accounts", consoleOrigin).toString(),
  });
  // Without a master key there is no app to send a welcome as.
  if (secretKey === null) return sessionHandler;
  return createSlackMemberJoinedHandler({
    agents: identities,
    bindings,
    welcome: createSlackWelcome({
      agents: agentStore,
      bindings,
      apps: createPostgresSlackAppStore(db, secretKey),
      outbox: createPostgresSlackOutboxStore(db),
      join: null,
      logger,
    }),
    next: sessionHandler,
  });
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
    const db = drizzle(pool, { schema });
    // Inbox and outbox share one pass budget. The inbox stops at half of it,
    // so a steady stream of mentions cannot starve the answers.
    const started = Date.now();
    const deadline = started + settings.passBudgetMs;
    const { catalog, connections, secretKey } =
      await slackRoleStartup(environment);
    const profiles = slackProfileCatalog(db, catalog, connections, environment);
    await profiles.workspace_profiles.refresh();
    const outbox = createPostgresSlackOutboxStore(db, {
      neutralize: eventNeutralizer(profiles, logger),
    });
    const drain = await drainSlackInbox({
      inbox: createPostgresSlackInboundEventStore(db),
      handler: slackSessionHandler({
        db,
        pool,
        environment,
        logger,
        catalog,
        connections,
        secretKey,
        leaseMs: settings.leaseMs,
        notices: createOutboxSlackNoticeSink(outbox),
        profiles,
      }),
      logger,
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      deadline: started + settings.passBudgetMs / 2,
    });
    if (drain.claimed > 0) logger.info("Slack inbox pass", drain);
    const secrets =
      secretKey === null ? null : createPostgresSecretStore(db, secretKey);
    const sent = await drainSlackOutbox({
      outbox,
      slack: createSlackBotApi({ apiUrl: slackApiUrlFrom(environment) }),
      botToken:
        secrets === null
          ? null
          : (workspaceId, slackAppId) =>
              slackBotToken(secrets, workspaceId, slackAppId),
      logger,
      consoleOrigin: consoleOriginFrom(environment),
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      deadline,
    });
    if (sent.enqueued + sent.claimed + sent.uncertain > 0) {
      logger.info("Slack outbox pass", sent);
    }
    return drain;
  } finally {
    await pool.end();
  }
}
