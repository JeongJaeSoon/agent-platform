import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import { DatabaseApiKeyStore } from "./keys.ts";

const authMode = process.env.AUTH_MODE;
const databaseUrl = process.env.DATABASE_URL;

if (authMode !== "none" && !databaseUrl) {
  throw new Error("DATABASE_URL is required unless AUTH_MODE=none");
}

const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl })
  : undefined;
const keyStore = pool ? new DatabaseApiKeyStore(drizzle(pool)) : undefined;
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  ...(keyStore === undefined ? {} : { keyStore }),
});

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
