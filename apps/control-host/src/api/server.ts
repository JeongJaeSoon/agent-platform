import { REQUEST_BODY_MAX_BYTES } from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  createPostgresPendingRequests,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresUsageReader,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
} from "@agent-platform/db";
import { createLogger } from "@agent-platform/observability";
import {
  catalogRevision,
  createInterruptService,
  createPendingRequestService,
  createSessionService,
  createUsageService,
  createWorkerGateway,
  InstallationConfigError,
  installationLimitProblems,
  installationLimitsFromEnv,
  ownerScopedPolicy,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  ApiSettingsError,
  apiSettingsFromEnv,
  apiSettingsProblems,
} from "./api-settings.ts";
import { createApiApp } from "./app.ts";
import { bootstrapGateFromEnv, DatabaseIdentityStore } from "./auth.ts";
import {
  DEFAULT_CONFIG_DIR,
  loadSessionCatalog,
  secretsManagerReader,
} from "./catalog-config.ts";
import {
  assertCheckpointBucketEncryption,
  assertCheckpointBucketProtection,
  checkpointGitMemoryBytesFromEnv,
  checkpointObjectRouteSigner,
  checkpointStorageConfigFromEnv,
  createApiCheckpoints,
} from "./checkpoints.ts";
import {
  createEgressAuthorizer,
  egressAuthorizerConfigFromEnv,
} from "./egress-authorizer.ts";
import { PostgresSessionNotifier } from "./events/notifications.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { createApiPool, createProbePool } from "./pool.ts";
import { createReadinessProbe } from "./readiness.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerInterruptRoutes } from "./routes/interrupt.ts";
import { registerPauseRoutes } from "./routes/pause.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerUsageRoutes } from "./routes/usage.ts";
import { registerWorkerRoutes } from "./routes/worker.ts";
import { createShutdown } from "./shutdown.ts";

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
const catalog = await loadSessionCatalog({
  dir: process.env.PLATFORM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
  env: process.env,
  readSecret: secretsManagerReader(process.env),
});
logger.info("Session catalog loaded", {
  revision: catalogRevision(catalog),
  profiles: Object.keys(catalog.profiles).length,
  repositories: Object.keys(catalog.repositories).length,
});

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
const checkpoints = createApiCheckpoints(
  db,
  checkpointStorage,
  checkpointGitMemoryBytes,
);
const sessions = createSessionService({
  authorization: ownerScopedPolicy,
  inputs: createPostgresSessionUnitOfWork(db),
  controls: createPostgresSessionControl(db),
  reader: createPostgresSessionReader(db, { logger }),
  catalog,
  limits,
});
// The same parsed limits admission and dispatch run under, so what this
// reports is what the gates enforce.
const usage = createUsageService({
  authorization: ownerScopedPolicy,
  reader: createPostgresUsageReader(db),
  limits,
});
const pendingRequests = createPendingRequestService({
  authorization: ownerScopedPolicy,
  store: createPostgresPendingRequests(db),
});
const interrupts = createInterruptService({
  authorization: ownerScopedPolicy,
  store: createPostgresTurnInterrupts(db),
});
const workers = createWorkerGateway({
  work: createPostgresWorkerUnitOfWork(db),
  catalog,
  // The storage-backed verifier: a checkpoint is promoted only after its
  // manifest, objects and workspace bundle were read back from S3 (checked by
  // git), and the pointer itself advances inside the turn's own transaction.
  checkpoints: checkpoints.verifier,
  ...(checkpoints.protocol === undefined
    ? {}
    : { checkpointProtocol: checkpoints.protocol }),
  pending: createPostgresWorkerPendingStore(db),
  options: {
    sessionCostLimitUsd: limits.sessionCostLimitUsd,
    leaseTtlMs: settings.leaseTtlMs,
    // How long a permission or question takes answers. The worker waits
    // exactly this long once the request is registered (94S-389).
    pendingTtlMs: settings.pendingTtlMs,
  },
});
// The egress proxy's authorizer (94S-252), on a port of its own that no
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
const auth = {
  identity,
  bootstrap: await bootstrapGateFromEnv(
    process.env.BOOTSTRAP_TOKEN,
    identity,
    logger,
  ),
  logger,
};
const probePool = createProbePool(databaseUrl, logger);
const shutdown = createShutdown({ logger });
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  logger,
  keyStore: new DatabaseApiKeyStore(db),
  identity,
  registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
  registerRoutes: (router) => {
    registerAuthRoutes(router, auth);
    registerSessionRoutes(router, sessions);
    registerPauseRoutes(router, sessions);
    registerReceiptRoutes(router, sessions);
    registerUsageRoutes(router, usage);
    registerPendingRoutes(router, pendingRequests);
    registerInterruptRoutes(router, interrupts);
    registerEventRoutes(router, sessions, {
      wakeup: notifier,
      logger,
      ...settings.sse,
    });
  },
  registerInternalRoutes: (router) => registerWorkerRoutes(router, workers),
  readiness: shutdown.readiness(
    createReadinessProbe({
      db: probePool,
      // AUTH_MODE unset still fails closed (every /v1 call is 401), which is
      // a misconfiguration, not a serving instance.
      // app.ts treats anything but "none" as api-key mode, so a typo would
      // silently run authenticated; only the two spellings we document count.
      requiredEnv: [
        "DATABASE_URL",
        { name: "AUTH_MODE", allowed: ["none", "api-key"] },
      ],
      // The same parser the process started with: an env that changed under
      // a running instance shows up here rather than at the next restart.
      configProblems: (environment) => [
        ...installationLimitProblems(environment),
        ...apiSettingsProblems(environment),
      ],
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
        { name: "event-listener", close: () => notifier.close() },
        { name: "pool", close: () => pool.end() },
        { name: "probe-pool", close: () => probePool.end() },
      ],
    );
  });
}
