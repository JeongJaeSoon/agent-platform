import * as schema from "@agent-platform/db";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "@agent-platform/db";
import { createLogger } from "@agent-platform/observability";
import {
  createSessionService,
  isCatalogEmpty,
  ownerScopedPolicy,
  parseSessionCatalogEnv,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { createApiApp } from "./app.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { API_POOL_TIMEOUTS, createApiPool, createProbePool } from "./pool.ts";
import { createReadinessProbe } from "./readiness.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";

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
  reader: createPostgresSessionReader(db),
  catalog,
});
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  logger,
  keyStore: new DatabaseApiKeyStore(db),
  registerRoutes: (router) => {
    registerSessionRoutes(router, sessions);
    registerReceiptRoutes(router, sessions);
  },
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

export default {
  port: Number(process.env.PORT ?? 3000),
  // Bun closes a response that has produced no bytes for idleTimeout seconds
  // (default 10). A request waiting on the pool's query_timeout must still
  // get its 503, so leave room above API_POOL_TIMEOUTS.queryMs.
  idleTimeout: Math.ceil(API_POOL_TIMEOUTS.queryMs / 1000) + 10,
  fetch: app.fetch,
};
