import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  linkAgentIdentityResponseSchema,
  listAgentIdentitiesResponseSchema,
  revokeAgentIdentityResponseSchema,
} from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  agentAdmins,
  agents,
  authzDecisions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresDecisionLog,
  memberships,
  receipts,
  registerSlackInstallation,
  users,
  verifySlackInstallation,
} from "@agent-platform/db";
import {
  agentForSlackEvent,
  createAgentIdentityService,
  createAuthorizationPolicy,
} from "@agent-platform/platform";
import { createTempDatabase, type TempDatabase } from "@agent-platform/testkit";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerAgentIdentityRoutes } from "./routes/agent-identities.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const APP = { appId: "A0RESEARCH", teamId: "T0ACME" };

integration("agent identities over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_identities_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
    };
    const service = createAgentIdentityService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
        decisions: createPostgresDecisionLog(db),
      }),
      store: createPostgresAgentIdentityStore(db),
    });
    app = createApiApp({
      authMode: "api-key",
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerAgentIdentityRoutes(router, { service });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const send = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const errorOf = async (response: Response) =>
    apiErrorResponseSchema.parse(await response.json()).error;
  const store = () => createPostgresAgentIdentityStore(db);

  let workspaceId = "";
  let ownerCookie = "";

  async function login(email: string) {
    const response = await app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const match = /__Host-ap_session=([^;]+)/.exec(
      response.headers.get("Set-Cookie") ?? "",
    );
    return `__Host-ap_session=${match?.[1] ?? ""}`;
  }

  async function addMember(email: string) {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email,
      passwordHash: await Bun.password.hash(PASSWORD, {
        algorithm: "argon2id",
      }),
      displayName: email,
    });
    await db
      .insert(memberships)
      .values({ workspaceId, userId: id, role: "member" });
    return id;
  }

  async function newAgent(slug: string, adminId?: string) {
    const id = crypto.randomUUID();
    await db.insert(agents).values({ id, workspaceId, slug, name: slug });
    if (adminId) {
      await db
        .insert(agentAdmins)
        .values({ workspaceId, agentId: id, userId: adminId });
    }
    return id;
  }

  const LINK = {
    provider: "slack_bot",
    app_id: APP.appId,
    team_id: APP.teamId,
    credential_ref: "slack/research-bot-token",
  };

  test("setup: an owner and a verified install of the agent's app", async () => {
    const boot = await app.request("/v1/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      }),
    });
    expect(boot.status).toBe(201);
    workspaceId = bootstrapResponseSchema.parse(await boot.json()).workspace.id;
    ownerCookie = await login("owner@example.com");
    await registerSlackInstallation(db, { ...APP, workspaceId });
    await verifySlackInstallation(db, { ...APP, botUserId: "B0RESEARCH" });
  });

  test("the agent's admin links its app; events resolve to it; revoking drops them", async () => {
    const managerId = await addMember("manager@example.com");
    const manager = await login("manager@example.com");
    const agentId = await newAgent("research", managerId);
    const other = await newAgent("finance");

    // Before any link, the app's events move no agent.
    expect(await agentForSlackEvent(store(), APP)).toEqual({
      status: "dropped",
      reason: "unidentified",
    });

    const linked = await send(
      "POST",
      `/v1/agents/${agentId}/identities`,
      manager,
      LINK,
    );
    expect(linked.status).toBe(201);
    const body = linkAgentIdentityResponseSchema.parse(await linked.json());
    expect(body.agent_identity).toMatchObject({
      agent_id: agentId,
      app_id: APP.appId,
      team_id: APP.teamId,
      bot_user_id: "B0RESEARCH",
      credential_ref: "slack/research-bot-token",
      status: "active",
      created_by: managerId,
    });

    expect(await agentForSlackEvent(store(), APP)).toMatchObject({
      status: "resolved",
      workspaceId,
      agentId,
      identity: { id: body.agent_identity.id, revision: 1 },
      botUserId: "B0RESEARCH",
    });
    // An event from another app, or one routed to another agent, is dropped.
    expect(
      await agentForSlackEvent(store(), { ...APP, appId: "A0OTHER" }),
    ).toEqual({ status: "dropped", reason: "not_installed" });
    expect(
      await agentForSlackEvent(store(), { ...APP, agentId: other }),
    ).toEqual({ status: "dropped", reason: "agent_mismatch" });

    // The same app cannot be pinned to another agent while this one holds it.
    const taken = await send(
      "POST",
      `/v1/agents/${other}/identities`,
      ownerCookie,
      LINK,
    );
    expect(taken.status).toBe(409);
    expect((await errorOf(taken)).code).toBe("AGENT_IDENTITY_TAKEN");

    const listed = await send(
      "GET",
      `/v1/agents/${agentId}/identities`,
      manager,
    );
    expect(
      listAgentIdentitiesResponseSchema.parse(await listed.json()).items,
    ).toHaveLength(1);

    const revoked = await send(
      "DELETE",
      `/v1/agents/${agentId}/identities/${body.agent_identity.id}`,
      manager,
    );
    expect(revoked.status).toBe(200);
    const revokedBody = revokeAgentIdentityResponseSchema.parse(
      await revoked.json(),
    );
    expect(revokedBody.agent_identity).toMatchObject({
      status: "revoked",
      revision: 2,
    });
    expect(await agentForSlackEvent(store(), APP)).toEqual({
      status: "dropped",
      reason: "identity_revoked",
    });

    const again = await send(
      "DELETE",
      `/v1/agents/${agentId}/identities/${body.agent_identity.id}`,
      manager,
    );
    expect(
      revokeAgentIdentityResponseSchema.parse(await again.json()).receipt_id,
    ).toBeNull();

    const written = await db
      .select({ operation: receipts.operation })
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(written.map((row) => row.operation).sort()).toEqual([
      "link_agent_identity",
      "revoke_agent_identity",
    ]);
  });

  test("another member, and a missing or unverified install, are refused", async () => {
    await addMember("other@example.com");
    const stranger = await login("other@example.com");
    const agentId = await newAgent("support");

    const refused = await send(
      "POST",
      `/v1/agents/${agentId}/identities`,
      stranger,
      LINK,
    );
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    });
    const [decision] = await db
      .select({ outcome: authzDecisions.outcome })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.action, "binding.manage"),
          eq(authzDecisions.reasonCode, "role"),
        ),
      );
    expect(decision?.outcome).toBe("deny");

    const missing = await send(
      "POST",
      `/v1/agents/${agentId}/identities`,
      ownerCookie,
      { ...LINK, app_id: "A0NOWHERE" },
    );
    expect(missing.status).toBe(409);
    expect((await errorOf(missing)).code).toBe("SLACK_NOT_INSTALLED");

    const noAgent = await send(
      "POST",
      `/v1/agents/${crypto.randomUUID()}/identities`,
      ownerCookie,
      LINK,
    );
    expect(noAgent.status).toBe(404);
  });
});
