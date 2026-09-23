import { REQUEST_BODY_MAX_BYTES } from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  createPostgresPendingRequests,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
} from "@agent-platform/db";
import { createLogger } from "@agent-platform/observability";
import {
  catalogRevision,
  createInterruptService,
  createPendingRequestService,
  createSessionService,
  createWorkerGateway,
  InstallationConfigError,
  installationLimitProblems,
  installationLimitsFromEnv,
  ownerScopedPolicy,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { createApiApp } from "./app.ts";
import { bootstrapGateFromEnv, DatabaseIdentityStore } from "./auth.ts";
import {
  DEFAULT_CONFIG_DIR,
  loadSessionCatalog,
  secretsManagerReader,
} from "./catalog-config.ts";
import {
  assertCheckpointBucketProtection,
  checkpointGitMemoryBytesFromEnv,
  checkpointStorageConfigFromEnv,
  createApiCheckpoints,
} from "./checkpoints.ts";
import { PostgresSessionNotifier } from "./events/notifications.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { heartbeatTtlMsFromEnv } from "./lease-config.ts";
import { createApiPool, createProbePool } from "./pool.ts";
import { createReadinessProbe } from "./readiness.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerInterruptRoutes } from "./routes/interrupt.ts";
import { registerPauseRoutes } from "./routes/pause.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerWorkerRoutes } from "./routes/worker.ts";

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
const leaseTtlMs = heartbeatTtlMsFromEnv(process.env.HEARTBEAT_TTL_SEC);

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
const pendingRequests = createPendingRequestService({
  authorization: ownerScopedPolicy,
  store: createPostgresPendingRequests(db),
});
const interrupts = createInterruptService({
  authorization: ownerScopedPolicy,
  store: createPostgresTurnInterrupts(db),
});
// How long a permission or question takes answers; unset keeps 30 minutes.
const pendingTtlSec = Number(process.env.PENDING_REQUEST_TTL_SEC);
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
    leaseTtlMs,
    ...(Number.isFinite(pendingTtlSec) && pendingTtlSec > 0
      ? { pendingTtlMs: pendingTtlSec * 1000 }
      : {}),
  },
});
// An unset or malformed value keeps the route's default rather than
// disabling the cap.
function positiveEnv<K extends string>(
  name: string,
  key: K,
): Partial<Record<K, number>> {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0
    ? ({ [key]: value } as Record<K, number>)
    : {};
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
    registerPendingRoutes(router, pendingRequests);
    registerInterruptRoutes(router, interrupts);
    registerEventRoutes(router, sessions, {
      wakeup: notifier,
      logger,
      ...positiveEnv("SSE_MAX_STREAMS", "maxStreams"),
      ...positiveEnv("SSE_MAX_STREAMS_PER_OWNER", "maxStreamsPerOwner"),
      ...positiveEnv("SSE_REPLAY_MAX_BYTES", "batchMaxBytes"),
    });
  },
  registerInternalRoutes: (router) => registerWorkerRoutes(router, workers),
  readiness: createReadinessProbe({
    db: createProbePool(databaseUrl, logger),
    // AUTH_MODE unset still fails closed (every /v1 call is 401), which is a
    // misconfiguration, not a serving instance.
    // app.ts treats anything but "none" as api-key mode, so a typo would
    // silently run authenticated; only the two spellings we document count.
    requiredEnv: [
      "DATABASE_URL",
      { name: "AUTH_MODE", allowed: ["none", "api-key"] },
    ],
    // The same parser the process started with: an env that changed under a
    // running instance shows up here rather than at the next restart.
    configProblems: installationLimitProblems,
  }),
});

// Bun resets a connection that has been idle for 10 seconds (default), and a
// reset carries no status, no request id and no retry hint. A /v1 request runs
// several database stages in sequence (key lookup, pool wait, BEGIN,
// statements, ROLLBACK), each bounded by its own pool timeout but together
// longer than 10 seconds. The app drives the clock through setIdleTimeout:
// above REQUEST_DEADLINE_MS around database work (deadline.ts answers 503
// first), on while it ingests a body (under BODY_DEADLINE_MS), and back to
// the default once the response is decided.
export default {
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
};
