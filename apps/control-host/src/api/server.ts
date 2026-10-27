import { REQUEST_BODY_MAX_BYTES } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  backfillSessionModels,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentAdminStore,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresAuditRetention,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresInviteStore,
  createPostgresLinkedAccountStore,
  createPostgresMcpEgressStore,
  createPostgresMemberStore,
  createPostgresPendingRequests,
  createPostgresPullRequests,
  createPostgresPushRequests,
  createPostgresSecretStore,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionTitleStore,
  createPostgresSessionUnitOfWork,
  createPostgresSlackAppStore,
  createPostgresSlackConfigTokenStore,
  createPostgresSlackGuestSetting,
  createPostgresSlackInboundEventStore,
  createPostgresSlackInstallStore,
  createPostgresSlackOutboxStore,
  createPostgresSurfaceBindingStore,
  createPostgresTeamStore,
  createPostgresTurnInterrupts,
  createPostgresUsageReader,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  createPostgresWorkspaceKeyStore,
  createPostgresWorkspaceProfileStore,
  hasUncollectedCheckpoint,
  slackAppKind,
} from "@werft-ai/db";
import { createLogger, sanitizeText } from "@werft-ai/observability";
import {
  agentSlackBotToken,
  allowedRun,
  catalogRevision,
  composeSlackFinalize,
  createAgentAdminService,
  createAgentIdentityService,
  createAgentService,
  createApiKeyService,
  createAuthorizationPolicy,
  createCredentialBindingService,
  createInterruptService,
  createInviteService,
  createLinkedAccountService,
  createMemberService,
  createPendingRequestService,
  createPullRequestService,
  createPushExecutor,
  createPushRequestService,
  createSessionOutputService,
  createSessionService,
  createSessionShareService,
  createSessionTitler,
  createSlackAppService,
  createSlackBotApi,
  createSlackChannelJoiner,
  createSlackChannelKinds,
  createSlackChannelSearchService,
  createSlackConfigApi,
  createSlackConfigTokens,
  createSlackEventsFinalize,
  createSlackEventsService,
  createSlackInstallService,
  createSlackLinkAppService,
  createSlackSecretService,
  createSlackSigningSecrets,
  createSlackWelcome,
  createSurfaceBindingService,
  createTeamService,
  createUsageService,
  createWorkerGateway,
  createWorkspaceProfileService,
  createWorkspaceProfiles,
  fingerprintModel,
  forgettingChannelsOnBindingPut,
  InstallationConfigError,
  installationLimitsFromEnv,
  resolveAgentRelease,
  SessionServiceError,
  WORKSPACE_PROFILE_REFRESH_MS,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  API_READINESS_REQUIRED_ENV,
  ApiSettingsError,
  apiReadinessConfigProblems,
  apiSettingsFromEnv,
} from "./api-settings.ts";
import { createApiApp } from "./app.ts";
import {
  bootstrapGateFromEnv,
  DatabaseIdentityStore,
  LoginLockout,
  WorkGate,
} from "./auth.ts";
import {
  DEFAULT_CONFIG_DIR,
  loadSecretKey,
  loadSessionCatalog,
  SECRET_KEY_SETTING,
  secretsManagerReader,
  unattendedProfiles,
} from "./catalog-config.ts";
import {
  assertCheckpointBucketEncryption,
  assertCheckpointBucketProtection,
  assertCheckpointObjectsPresent,
  checkpointGitMemoryBytesFromEnv,
  checkpointObjectRouteSigner,
  checkpointStorageConfigFromEnv,
  createApiCheckpoints,
} from "./checkpoints.ts";
import {
  createEgressAuthorizer,
  egressAuthorizerConfigFromEnv,
  sessionTitleEgressUrlFromEnv,
} from "./egress-authorizer.ts";
import { forgesOf } from "./forge-github.ts";
import { createGitPusher } from "./git-push.ts";
import { createGoogleLogin, googleLoginConfigFromEnv } from "./google-login.ts";
import { DatabaseApiKeyStore, generateApiKey, hashApiKey } from "./keys.ts";
import { eventNeutralizer, startNeutralFill } from "./neutral-fields.ts";
import { createApiPool, createProbePool } from "./pool.ts";
import { createSlackEventsLimiter } from "./rate-limit.ts";
import { createReadinessProbe } from "./readiness.ts";
import { registerAgentIdentityRoutes } from "./routes/agent-identities.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerApiKeyRoutes } from "./routes/api-keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerCloseRoutes } from "./routes/close.ts";
import { registerCredentialBindingRoutes } from "./routes/credential-bindings.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerInterruptRoutes } from "./routes/interrupt.ts";
import {
  registerInviteRoutes,
  registerPublicInviteRoutes,
} from "./routes/invites.ts";
import { registerLinkedAccountRoutes } from "./routes/linked-accounts.ts";
import { registerMemberRoutes } from "./routes/members.ts";
import { registerSessionOutputRoutes } from "./routes/outputs.ts";
import { registerPauseRoutes } from "./routes/pause.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerProfileRoutes } from "./routes/profiles.ts";
import { registerPullRequestRoutes } from "./routes/pull-requests.ts";
import { registerPushRequestRoutes } from "./routes/push-requests.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";
import { registerSessionShareRoutes } from "./routes/session-shares.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSlackAppRoutes } from "./routes/slack-apps.ts";
import { registerSlackBindingRoutes } from "./routes/slack-bindings.ts";
import { registerSlackChannelRoutes } from "./routes/slack-channels.ts";
import { registerSlackEventRoutes } from "./routes/slack-events.ts";
import { registerSlackInstallRoutes } from "./routes/slack-install.ts";
import { registerSlackSecretRoutes } from "./routes/slack-secrets.ts";
import { registerTeamRoutes } from "./routes/teams.ts";
import { registerUsageRoutes } from "./routes/usage.ts";
import { registerWorkerRoutes } from "./routes/worker.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { PostgresSessionNotifier } from "./session-notifier.ts";
import { createShutdown } from "./shutdown.ts";
import {
  consoleOriginFrom,
  slackApiUrlFrom,
  slackEventsPublicUrlFrom,
} from "./slack-config.ts";
import { signInWithSlackOff, slackOidcSettingsFromEnv } from "./slack-link.ts";

const authMode = process.env.AUTH_MODE;
const databaseUrl = process.env.DATABASE_URL;

// The sessions API is storage-backed, so a process without a database would
// advertise routes it cannot serve; refuse to start instead.
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const logger = createLogger();
const limits = (() => {
  try {
    return installationLimitsFromEnv(process.env);
  } catch (error) {
    // Every problem in one line before the process dies, so the operator
    // fixes the env file once instead of once per variable.
    if (error instanceof InstallationConfigError) {
      logger.error("Refusing to start: installation limits are invalid", {
        problems: error.problems,
      });
    }
    throw error;
  }
})();
const settings = (() => {
  try {
    return apiSettingsFromEnv(process.env);
  } catch (error) {
    if (error instanceof ApiSettingsError) {
      logger.error("Refusing to start: API settings are invalid", {
        problems: error.problems,
      });
    }
    throw error;
  }
})();
const catalogSource = {
  dir: process.env.PLATFORM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
  env: process.env,
  readSecret: secretsManagerReader(process.env),
};
const catalog = await loadSessionCatalog(catalogSource);
const secretKey = await loadSecretKey(catalogSource);
if (secretKey === null) {
  logger.warn(
    `Secret store is off (${SECRET_KEY_SETTING} unset); Slack secrets cannot be set`,
    {},
  );
}
logger.info("Session catalog loaded", {
  revision: catalogRevision(catalog),
  profiles: Object.keys(catalog.profiles).length,
  repositories: Object.keys(catalog.repositories).length,
});
const unattended = unattendedProfiles(catalog);
if (unattended.length > 0) {
  logger.warn("Profiles run tools without asking for approval", {
    profiles: unattended,
  });
}

// Checked before the pool exists: a bucket that is missing is a startup
// error, not a warning, unless the operator said there is none.
const checkpointStorage = checkpointStorageConfigFromEnv(process.env);
const checkpointGitMemoryBytes = checkpointGitMemoryBytesFromEnv(process.env);
if (checkpointStorage === "disabled") {
  logger.warn(
    "Checkpoint object store is disabled; every checkpoint will be refused and no session can be restored",
    {},
  );
} else if (checkpointStorage.protection === "unversioned") {
  logger.warn(
    "Checkpoint objects are not pinned by version or held; an object deleted or overwritten after its checkpoint committed is found at restore, not prevented",
    { bucket: checkpointStorage.bucket },
  );
} else {
  await assertCheckpointBucketProtection(checkpointStorage);
}
if (checkpointStorage !== "disabled") {
  await assertCheckpointBucketEncryption(checkpointStorage, {
    warn: (message, fields) => logger.warn(message, fields),
  });
}

const pool = createApiPool(databaseUrl, logger);
const db = drizzle(pool, { schema });
const workspaceProfileStore = createPostgresWorkspaceProfileStore(db);
const workspaceProfileVersions = createWorkspaceProfiles(workspaceProfileStore);
catalog.workspace_profiles = workspaceProfileVersions;
const refreshWorkspaceProfiles = (): void => {
  workspaceProfileVersions
    .refresh(WORKSPACE_PROFILE_REFRESH_MS)
    .catch((error: unknown) => {
      logger.warn("Workspace profiles could not be read; retrying", {
        error_name: error instanceof Error ? error.name : typeof error,
      });
    });
};
refreshWorkspaceProfiles();
setInterval(refreshWorkspaceProfiles, WORKSPACE_PROFILE_REFRESH_MS).unref();
// Not awaited: the API starts without its database, and a version 1
// fingerprint names its model, so nothing waits on the column being filled.
const MODEL_BACKFILL_RETRY_MS = 30_000;
const backfillModels = (): void => {
  backfillSessionModels(db, ({ profileId, fingerprint }) =>
    fingerprintModel(catalog, profileId, fingerprint),
  ).then(
    (sessions) => logger.info("Session models backfilled", { sessions }),
    (error: unknown) => {
      logger.warn("Session models could not be backfilled; retrying", {
        error_name: error instanceof Error ? error.name : typeof error,
      });
      setTimeout(backfillModels, MODEL_BACKFILL_RETRY_MS).unref();
    },
  );
};
backfillModels();
const neutralize = eventNeutralizer(catalog, logger);
startNeutralFill(db, neutralize, logger);
if (checkpointStorage !== "disabled") {
  await assertCheckpointObjectsPresent(checkpointStorage, {
    hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
  });
}
const checkpoints = createApiCheckpoints(
  db,
  checkpointStorage,
  checkpointGitMemoryBytes,
);
const credentialBindings = createPostgresCredentialBindingStore(db);
const slackGuests = createPostgresSlackGuestSetting(db);
const sessionShares = createPostgresSessionShareStore(db);
const authorization = createAuthorizationPolicy({
  ...(authMode === "none"
    ? {}
    : { identity: createDatabaseIdentityReader(db) }),
  agents: createDatabaseAgentAuthority(db),
  credentials: credentialBindings,
  slackGuests,
  sessions: sessionShares,
  decisions: createPostgresDecisionLog(db),
});
const agentStore = createPostgresAgentStore(db);
const surfaceBindingStore = createPostgresSurfaceBindingStore(db);
const slackBotApi = createSlackBotApi({ apiUrl: slackApiUrlFrom(process.env) });
const slackAppStore =
  secretKey === null ? null : createPostgresSlackAppStore(db, secretKey);
const slackJoin =
  secretKey === null || slackAppStore === null // narrows both
    ? null
    : createSlackChannelJoiner({
        bindings: surfaceBindingStore,
        slack: slackBotApi,
        botToken: (workspaceId, agentId) =>
          agentSlackBotToken(
            {
              apps: slackAppStore,
              secrets: createPostgresSecretStore(db, secretKey),
            },
            workspaceId,
            agentId,
          ),
      });
const slackWelcome =
  slackAppStore === null
    ? null
    : createSlackWelcome({
        agents: agentStore,
        bindings: surfaceBindingStore,
        apps: slackAppStore,
        outbox: createPostgresSlackOutboxStore(db),
        join: slackJoin,
        logger,
      });
const agents = createAgentService({
  authorization,
  store: agentStore,
  catalog,
  credentials: credentialBindings,
  ...(slackWelcome === null ? {} : { welcome: slackWelcome }),
  keys: createPostgresWorkspaceKeyStore(db),
});
const sessions = createSessionService({
  authorization,
  inputs: createPostgresSessionUnitOfWork(db),
  controls: createPostgresSessionControl(db, {
    connect: () => pool.connect(),
    logger,
  }),
  reader: createPostgresSessionReader(db, { logger, neutralize }),
  catalog,
  releases: agents,
  credentials: credentialBindings,
  limits,
});
const sessionOutputs = createSessionOutputService({
  sessions,
  source: checkpoints.outputs,
});
// The same parsed limits admission and dispatch run under, so what this
// reports is what the gates enforce.
const usage = createUsageService({
  authorization,
  reader: createPostgresUsageReader(db),
  limits,
});
const pendingRequests = createPendingRequestService({
  authorization,
  store: createPostgresPendingRequests(db),
});
const members = createMemberService({
  authorization,
  store: createPostgresMemberStore(db),
});
const agentIdentities = createAgentIdentityService({
  authorization,
  store: createPostgresAgentIdentityStore(db),
});
const slackBindings = createSurfaceBindingService({
  authorization,
  store: surfaceBindingStore,
  channels: createSlackChannelKinds({
    apps: slackAppStore,
    secrets:
      secretKey === null ? null : createPostgresSecretStore(db, secretKey),
    slack: slackBotApi,
  }),
  ...(slackJoin === null ? {} : { join: slackJoin }),
  ...(slackWelcome === null ? {} : { welcome: slackWelcome }),
});
const linkedAccounts = createLinkedAccountService({
  authorization,
  store: createPostgresLinkedAccountStore(db),
});
const slackOidc = slackOidcSettingsFromEnv(process.env);
const slackConfigApi = createSlackConfigApi({
  apiUrl: slackApiUrlFrom(process.env),
});
const slackConfigTokens =
  secretKey === null
    ? null
    : createSlackConfigTokens({
        store: createPostgresSlackConfigTokenStore(db, secretKey),
        api: slackConfigApi,
      });
const consoleOrigin = consoleOriginFrom(process.env);
if (consoleOrigin === null) {
  logger.warn(
    "Slack apps cannot be created (SLACK_OIDC_REDIRECT_URI unset): their OAuth redirect is on the console's origin",
    {},
  );
}
const slackLinkOff = signInWithSlackOff(slackOidc, secretKey !== null);
if (slackLinkOff !== null) logger.warn(slackLinkOff, {});
const slackSecrets = createSlackSecretService({
  authorization,
  store: secretKey === null ? null : createPostgresSecretStore(db, secretKey),
  tokens: slackConfigTokens,
  appKind: (workspaceId, slackAppId) =>
    slackAppKind(db, workspaceId, slackAppId),
});
const slackSigningSecrets =
  secretKey === null || slackAppStore === null // narrows both
    ? null
    : createSlackSigningSecrets({
        apps: slackAppStore,
        secrets: createPostgresSecretStore(db, secretKey),
      });
const slackChannels = createSlackChannelSearchService({
  authorization,
  agents: createDatabaseAgentAuthority(db),
  apps: slackAppStore,
  secrets: secretKey === null ? null : createPostgresSecretStore(db, secretKey),
  api: slackBotApi,
});
const slackApps = createSlackAppService({
  authorization,
  apps: slackAppStore,
  tokens: slackConfigTokens,
  api: slackConfigApi,
  consoleOrigin,
  eventsPublicUrl: slackEventsPublicUrlFrom(process.env),
  onAgentAppChanged: (agentId) => slackSigningSecrets?.invalidate(agentId),
  activeReleaseWarning: async (workspaceId, agentId) => {
    const release = (await agentStore.get(workspaceId, agentId))
      ?.active_release;
    if (!release) return { code: "no_active_release" };
    try {
      await resolveAgentRelease(
        { store: agentStore, catalog },
        workspaceId,
        release.id,
      );
    } catch (error) {
      if (
        error instanceof SessionServiceError &&
        error.code === "PROFILE_DIGEST_MISMATCH"
      ) {
        return {
          code: "profile_unavailable",
          profile_id: release.runtime_profile_id,
        };
      }
      throw error;
    }
    // Missing and dropped from the catalog take the same fix: a new release.
    return allowedRun(
      catalog,
      release.runtime_profile_id,
      release.repository_id,
    ) === null
      ? { code: "repository_required", profile_id: release.runtime_profile_id }
      : null;
  },
});
const slackEventsPublicUrl = slackEventsPublicUrlFrom(process.env);
if (slackEventsPublicUrl === null) {
  logger.warn(
    "Slack apps get no event subscription (SLACK_EVENTS_PUBLIC_URL unset): installs finish with events_url_unset",
    {},
  );
}
const slackInstallStore = createPostgresSlackInstallStore(db);
const slackIdentityStore = createPostgresAgentIdentityStore(db);
const slackEvents = createSlackEventsService({
  signingSecrets: slackSigningSecrets ?? { forAgent: async () => null },
  inbox: createPostgresSlackInboundEventStore(db),
  apps: slackAppStore ?? { setEventsUnlessVerified: async () => {} },
  identities: slackIdentityStore,
  installs: slackInstallStore,
});
const slackInstall = createSlackInstallService({
  authorization,
  apps: slackAppStore,
  states: secretKey === null ? null : slackInstallStore,
  secrets: secretKey === null ? null : createPostgresSecretStore(db, secretKey),
  tokens: slackConfigTokens,
  identities: slackIdentityStore,
  api: slackConfigApi,
  ...(slackAppStore === null || slackWelcome === null
    ? {}
    : {
        finalize: composeSlackFinalize(
          createSlackEventsFinalize({
            apps: slackApps,
            agents: slackAppStore,
            publicUrl: slackEventsPublicUrl,
          }),
          slackWelcome.finalize,
        ),
      }),
});
const slackLinkApps = createSlackLinkAppService({
  authorization,
  apps: slackAppStore,
  tokens: slackConfigTokens,
  api: slackConfigApi,
  consoleOrigin,
  fallback:
    slackOidc?.client == null
      ? null
      : { ...slackOidc.client, redirectUri: slackOidc.redirectUri },
});
const credentialBindingService = createCredentialBindingService({
  authorization,
  store: credentialBindings,
});
const apiKeys = createApiKeyService({
  authorization,
  store: createPostgresWorkspaceKeyStore(db),
  mint: () => {
    const secret = generateApiKey();
    return { secret, hash: hashApiKey(secret) };
  },
});
const shares = createSessionShareService({
  authorization,
  store: sessionShares,
});
const teams = createTeamService({
  authorization,
  store: createPostgresTeamStore(db),
});
const workspaceProfiles = createWorkspaceProfileService({
  authorization,
  store: workspaceProfileStore,
  catalog: { ...catalog, workspace_profiles: workspaceProfileVersions },
});
const agentAdmins = createAgentAdminService({
  authorization,
  store: createPostgresAgentAdminStore(db),
});
const inviteStore = createPostgresInviteStore(db);
const invites = createInviteService({ authorization, store: inviteStore });
// One adapter per repository, shared by clone (the gateway), push and pull
// requests, so all draw on one token cache.
const forges = forgesOf(catalog, { logger });
const pushStore = createPostgresPushRequests(db);
const pushRequests = createPushRequestService({
  authorization,
  store: pushStore,
  source: checkpoints.pushSource,
  catalog,
});
const pullRequests = createPullRequestService({
  authorization,
  store: createPostgresPullRequests(db),
  catalog,
  forges,
  redact: sanitizeText,
});
const pushExecutor = createPushExecutor({
  store: pushStore,
  catalog,
  forges,
  bundles: checkpoints.pushSource,
  pusher: createGitPusher({ maxGitMemoryBytes: checkpointGitMemoryBytes }),
  logger,
}).start();
const interrupts = createInterruptService({
  authorization,
  store: createPostgresTurnInterrupts(db, { logger }),
});
const shutdown = createShutdown({ logger });
const titleEgressUrl = sessionTitleEgressUrlFromEnv(process.env);
const titleStore = createPostgresSessionTitleStore(db);
if (titleEgressUrl === null) {
  logger.info(
    "Generated session titles are off (SESSION_TITLE_EGRESS_URL unset)",
    {},
  );
}
const workers = createWorkerGateway({
  work: createPostgresWorkerUnitOfWork(db, { logger }),
  catalog,
  neutralize,
  // The storage-backed verifier: a checkpoint is promoted only after its
  // manifest, objects and workspace bundle were read back from S3 (checked by
  // git), and the pointer itself advances inside the turn's own transaction.
  checkpoints: checkpoints.verifier,
  ...(checkpoints.protocol === undefined
    ? {}
    : { checkpointProtocol: checkpoints.protocol }),
  pending: createPostgresWorkerPendingStore(db),
  forges,
  mcp: createPostgresMcpEgressStore(db),
  onMcpReceiptError: (error) =>
    logger.error("MCP refusal receipt not recorded", {
      error: error instanceof Error ? error.name : "error",
    }),
  ...(titleEgressUrl === null
    ? {}
    : {
        titles: {
          store: titleStore,
          titler: createSessionTitler({
            store: titleStore,
            catalog,
            egressUrl: titleEgressUrl,
            onError: (error, context) =>
              logger.warn(
                "Session title not generated; the derived one stays",
                {
                  session_id: context.sessionId,
                  error: error instanceof Error ? error.message : "error",
                },
              ),
          }),
        },
      }),
  options: {
    sessionCostLimitUsd: limits.sessionCostLimitUsd,
    sessionTokenLimit: limits.sessionTokenLimit,
    leaseTtlMs: settings.leaseTtlMs,
    // How long a permission or question takes answers. The worker waits
    // exactly this long once the request is registered.
    pendingTtlMs: settings.pendingTtlMs,
    stopWaiting: shutdown.stopWaiting,
  },
});
// The egress proxy's authorizer, on a port of its own that no
// worker allowlist names. Read before anything listens, so a half-set pair
// stops the process instead of starting an API whose workers cannot reach
// their provider.
const egressAuthorizer = egressAuthorizerConfigFromEnv(process.env);
const authorizerListener =
  egressAuthorizer === null
    ? undefined
    : Bun.serve({
        hostname: egressAuthorizer.hostname,
        port: egressAuthorizer.port,
        fetch: createEgressAuthorizer({
          gateway: workers,
          logger,
          ...(checkpointStorage === "disabled"
            ? {}
            : { objectStore: checkpointObjectRouteSigner(checkpointStorage) }),
          token: egressAuthorizer.token,
        }),
      });
if (authorizerListener === undefined) {
  logger.warn(
    "Egress authorizer is off (EGRESS_AUTHORIZER_PORT unset); workers cannot reach their provider, repository or object store",
    {},
  );
} else {
  logger.info("Egress authorizer listening", {
    port: authorizerListener.port,
  });
}

// Wakes SSE streams on NOTIFY; streams still re-read on their keepalive
// clock, so a listener that is down only adds latency, never loses events.
const notifier = new PostgresSessionNotifier(databaseUrl, logger);
void notifier.start();
const identity = new DatabaseIdentityStore(db);
const google = googleLoginConfigFromEnv(process.env);
if (google.problems.length > 0) {
  throw new Error(
    `Invalid Google sign-in settings: ${google.problems.join("; ")}`,
  );
}
// One window and one hashing gate for every account password check (login,
// the reset issuer's re-check, invite accept), so no route resets another's
// count.
const lockout = new LoginLockout();
const passwordWork = new WorkGate();
const auth = {
  identity,
  ...(google.config ? { google: createGoogleLogin(google.config) } : {}),
  lockout,
  passwordWork,
  bootstrap: await bootstrapGateFromEnv(
    process.env.BOOTSTRAP_TOKEN,
    identity,
    logger,
  ),
  logger,
};
const probePool = createProbePool(databaseUrl, logger);
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  logger,
  keyStore: new DatabaseApiKeyStore(db),
  identity,
  authorization,
  registerPublicRoutes: (router) => {
    registerPublicAuthRoutes(router, auth);
    registerSlackEventRoutes(router, {
      events: slackEvents,
      limiter: createSlackEventsLimiter(),
      logger,
    });
    registerPublicInviteRoutes(router, {
      invites: inviteStore,
      identity,
      lockout,
      passwordWork,
      logger,
    });
  },
  registerRoutes: (router) => {
    registerAuthRoutes(router, auth);
    registerInviteRoutes(router, invites);
    registerWorkspaceRoutes(router, {
      authorization,
      retention: createPostgresAuditRetention(db),
      slackGuests,
    });
    registerSlackSecretRoutes(router, slackSecrets);
    registerSessionRoutes(router, sessions);
    registerSessionOutputRoutes(router, sessionOutputs);
    registerSessionShareRoutes(router, shares, sessions);
    registerPauseRoutes(router, sessions);
    registerCloseRoutes(router, sessions);
    registerReceiptRoutes(router, sessions);
    registerUsageRoutes(router, usage);
    registerProfileRoutes(router, workspaceProfiles);
    registerPendingRoutes(router, pendingRequests);
    registerPushRequestRoutes(router, pushRequests);
    registerPullRequestRoutes(router, pullRequests);
    registerInterruptRoutes(router, interrupts);
    registerLinkedAccountRoutes(router, {
      service: linkedAccounts,
      slack:
        slackOidc === null
          ? null
          : { issuer: slackOidc.issuer, clients: slackLinkApps },
      logger,
    });
    registerMemberRoutes(router, members, invites);
    registerAgentRoutes(router, agents);
    registerAgentIdentityRoutes(router, {
      service: agentIdentities,
      logger,
    });
    registerSlackBindingRoutes(router, {
      service: forgettingChannelsOnBindingPut(slackBindings, slackChannels),
      logger,
    });
    registerSlackChannelRoutes(router, { service: slackChannels, logger });
    registerSlackAppRoutes(router, {
      apps: slackApps,
      secrets: slackSecrets,
      logger,
    });
    registerSlackInstallRoutes(router, { service: slackInstall, logger });
    registerApiKeyRoutes(router, apiKeys);
    registerTeamRoutes(router, teams, agentAdmins);
    registerCredentialBindingRoutes(router, credentialBindingService);
    registerEventRoutes(router, sessions, {
      wakeup: notifier,
      logger,
      ...settings.sse,
    });
  },
  registerInternalRoutes: (router) => registerWorkerRoutes(router, workers),
  ...(settings.webDistDir === undefined
    ? {}
    : { webDistDir: settings.webDistDir }),
  readiness: shutdown.readiness(
    createReadinessProbe({
      db: probePool,
      requiredEnv: API_READINESS_REQUIRED_ENV,
      configProblems: apiReadinessConfigProblems,
    }),
  ),
});

// Bun resets a connection that has been idle for 10 seconds (default), and a
// reset carries no status, no request id and no retry hint. A /v1 request runs
// several database stages in sequence (key lookup, pool wait, BEGIN,
// statements, ROLLBACK), each bounded by its own pool timeout but together
// longer than 10 seconds. The app drives the clock through setIdleTimeout:
// above REQUEST_DEADLINE_MS around database work (deadline.ts answers 503
// first), on while it ingests a body (under BODY_DEADLINE_MS), and back to
// the default once the response is decided.
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  // Bun's own cap (default 128 MiB) applies before any handler runs and
  // answers without the API's error envelope, so it sits above the contract
  // limit: the app produces the documented 413 up to twice the limit, and
  // only a grossly oversized upload is cut at the transport.
  maxRequestBodySize: REQUEST_BODY_MAX_BYTES * 2,
  fetch(
    request: Request,
    server: { timeout(r: Request, seconds: number): void },
  ): Response | Promise<Response> {
    return app.fetch(request, {
      setIdleTimeout: (seconds: number) => server.timeout(request, seconds),
    });
  },
});
// With PORT=0 the OS picks the port; this line is the only place it shows.
logger.info("API listening", { port: server.port });

// Pools close last: requests still draining hold their clients until then.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown.run(
      signal,
      // The authorizer drains with the API: a proxy exchange mid-regrant
      // gets its answer, and one refused after the stop rides its grace.
      authorizerListener === undefined
        ? [server]
        : [server, authorizerListener],
      [
        { name: "push-executor", close: () => pushExecutor.stop() },
        { name: "event-listener", close: () => notifier.close() },
        { name: "pool", close: () => pool.end() },
        { name: "probe-pool", close: () => probePool.end() },
      ],
    );
  });
}
