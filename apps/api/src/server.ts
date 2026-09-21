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

if (authMode !== "none" && !databaseUrl) {
  throw new Error("DATABASE_URL is required unless AUTH_MODE=none");
}

const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : undefined;
const db = pool ? drizzle(pool, { schema }) : undefined;
const keyStore = db ? new DatabaseApiKeyStore(db) : undefined;
const sessions = db
  ? createSessionService({
      authorization: ownerScopedPolicy,
      inputs: createPostgresSessionUnitOfWork(db),
      reader: createPostgresSessionReader(db),
      catalog: parseSessionCatalog(process.env.SESSION_CATALOG_JSON),
    })
  : undefined;
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  ...(keyStore === undefined ? {} : { keyStore }),
  registerRoutes(router) {
    if (sessions) registerSessionRoutes(router, sessions);
  },
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
