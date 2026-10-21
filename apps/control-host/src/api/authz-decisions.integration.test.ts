import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import {
  authzDecisions,
  createApiKey,
  createPostgresDecisionLog,
} from "@agent-platform/db";
import { createAuthorizationPolicy } from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import { DatabaseApiKeyStore, generateApiKey, hashApiKey } from "./keys.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("decision audit over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  const readOnlyKey = generateApiKey();
  const keyId = crypto.randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "authz_http_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    await createApiKey(db, {
      id: keyId,
      ownerId: "owner-audit",
      keyHash: hashApiKey(readOnlyKey),
      scopes: ["sessions:read"],
    });
    app = createApiApp({
      authMode: "api-key",
      keyStore: new DatabaseApiKeyStore(db),
      authorization: createAuthorizationPolicy({
        decisions: createPostgresDecisionLog(db),
      }),
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  test("a key refused for a missing scope leaves the row its X-Request-Id names", async () => {
    const response = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readOnlyKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).not.toBeNull();

    const rows = await db
      .select()
      .from(authzDecisions)
      .where(eq(authzDecisions.requestId, requestId ?? ""));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: "owner-audit",
      principalKind: "api_key",
      principalId: keyId,
      surface: { kind: "api" },
      action: "session.submit",
      resourceKind: "session",
      outcome: "deny",
      reasonCode: "role",
    });
  });

  test("a request the key may make leaves no row", async () => {
    const response = await app.request("http://localhost/v1", {
      headers: { Authorization: `Bearer ${readOnlyKey}` },
    });
    expect(response.status).toBe(200);
    const requestId = response.headers.get("X-Request-Id") ?? "";
    expect(
      await db
        .select()
        .from(authzDecisions)
        .where(eq(authzDecisions.requestId, requestId)),
    ).toEqual([]);
  });
});
