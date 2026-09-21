import * as schema from "@agent-platform/db";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "@agent-platform/db";
import {
  createSessionService,
  ownerScopedPolicy,
  parseSessionCatalog,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";

const authMode = process.env.AUTH_MODE;
const databaseUrl = process.env.DATABASE_URL;

// The sessions API is storage-backed, so a process without a database would
// advertise routes it cannot serve; refuse to start instead.
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const db = drizzle(new Pool({ connectionString: databaseUrl }), { schema });
const sessions = createSessionService({
  authorization: ownerScopedPolicy,
  inputs: createPostgresSessionUnitOfWork(db),
  reader: createPostgresSessionReader(db),
  catalog: parseSessionCatalog(process.env.SESSION_CATALOG_JSON),
});
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  keyStore: new DatabaseApiKeyStore(db),
  registerRoutes: (router) => registerSessionRoutes(router, sessions),
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
