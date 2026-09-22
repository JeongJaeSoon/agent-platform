import { REQUEST_BODY_MAX_BYTES } from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@agent-platform/db";
import { createLogger } from "@agent-platform/observability";
import {
  createSessionService,
  createWorkerGateway,
  DEFAULT_LEASE_TTL_MS,
  isCatalogEmpty,
  ownerScopedPolicy,
  parseSessionCatalogEnv,
  rejectUnverifiedCheckpoints,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { createApiApp } from "./app.ts";
import { PostgresSessionNotifier } from "./events/notifications.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { createApiPool, createProbePool } from "./pool.ts";
import { createReadinessProbe } from "./readiness.ts";
import { registerEventRoutes } from "./routes/events.ts";
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
const catalog = parseSessionCatalogEnv(
  "SESSION_CATALOG_JSON",
  process.env.SESSION_CATALOG_JSON,
);
if (isCatalogEmpty(catalog)) {
  // Every POST /v1/sessions answers 422 until the catalog lists at least one
  // profile and one repository; say so once instead of failing silently.
  logger.warn("Session catalog is empty; session creation will be rejected", {
    profiles: Object.keys(catalog.profiles).length,
    repositories: Object.keys(catalog.repositories).length,
  });
}

const pool = createApiPool(databaseUrl, logger);
const db = drizzle(pool, { schema });
const sessions = createSessionService({
  authorization: ownerScopedPolicy,
  inputs: createPostgresSessionUnitOfWork(db),
  controls: createPostgresSessionControl(db),
  reader: createPostgresSessionReader(db),
  catalog,
});
// Seconds so an operator can shorten it in a test deployment; the worker
// heartbeats at a fraction of this.
const heartbeatTtlSec = Number(process.env.HEARTBEAT_TTL_SEC);
const workers = createWorkerGateway({
  work: createPostgresWorkerUnitOfWork(db),
  catalog,
  // Fails closed: the storage-backed CheckpointService exists (94S-124) but
  // nothing binds it to this gateway yet (94S-201), so a finalize that carries
  // a checkpoint is refused rather than promoted unread. Turns without a
  // checkpoint finalize normally.
  checkpoints: rejectUnverifiedCheckpoints,
  options: {
    leaseTtlMs:
      Number.isFinite(heartbeatTtlSec) && heartbeatTtlSec > 0
        ? heartbeatTtlSec * 1000
        : DEFAULT_LEASE_TTL_MS,
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
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  logger,
  keyStore: new DatabaseApiKeyStore(db),
  registerRoutes: (router) => {
    registerSessionRoutes(router, sessions);
    registerReceiptRoutes(router, sessions);
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
  }),
});

// Bun resets a connection that has been idle for 10 seconds (default), and a
// reset carries no status, no request id and no retry hint. A /v1 request runs
// several database stages in sequence (key lookup, pool wait, BEGIN,
// statements, ROLLBACK), each bounded by its own pool timeout but together
// longer than 10 seconds. The app drives the clock through setIdleTimeout:
// off around database work, on while it ingests a body, so the database
// timeouts bound the former and slow senders are still cut off during the
// latter. An absolute per-request deadline is 94S-205.
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
