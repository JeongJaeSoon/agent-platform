import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  activationCredentialUnboundDetailsSchema,
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CREDENTIAL_REVOKE_NOTICE,
  CREDENTIAL_UNBOUND_GUIDANCE,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createAgentReleaseResponseSchema,
  createApiKeyResponseSchema,
  createCredentialBindingResponseSchema,
  createSessionResponseSchema,
  listCredentialBindingsResponseSchema,
  revokeCredentialBindingResponseSchema,
  sessionCredentialUnboundDetailsSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  authzDecisions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkspaceKeyStore,
  memberships,
  receipts,
  users,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAgentService,
  createApiKeyService,
  createAuthorizationPolicy,
  createCredentialBindingService,
  createSessionService,
  type SessionCatalog,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore, generateApiKey, hashApiKey } from "./keys.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerApiKeyRoutes } from "./routes/api-keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerCredentialBindingRoutes } from "./routes/credential-bindings.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const REF = "notion_token";

const catalog: SessionCatalog = {
  profiles: {
    "claude-coding-v1": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "default",
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key",
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
    },
  },
};

const card = {
  role: "기록 정리",
  instructions: "회의록을 읽고 할 일을 정리한다.",
  language: "ko" as const,
  model: "claude-sonnet-5",
  capabilities: {
    tools: ["Read"],
    mcp: null,
    forbidden: [],
    credential_refs: [REF],
  },
  rules: [],
};

// Design 4.4 scene 4 over HTTP: an agent's admin binds the names its card
// uses; activation and every new session recheck them.
integration("credential bindings over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "credential_bindings_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger,
    };
    const credentials = createPostgresCredentialBindingStore(db);
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: createDatabaseAgentAuthority(db),
      credentials,
      decisions: createPostgresDecisionLog(db),
    });
    const agents = createAgentService({
      authorization,
      store: createPostgresAgentStore(db),
      catalog,
      credentials,
    });
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization,
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog,
      releases: agents,
      credentials,
    });
    const keys = createApiKeyService({
      authorization,
      store: createPostgresWorkspaceKeyStore(db),
      mint: () => {
        const secret = generateApiKey();
        return { secret, hash: hashApiKey(secret) };
      },
    });
    const bindings = createCredentialBindingService({
      authorization,
      store: credentials,
    });
    app = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      authorization,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerSessionRoutes(router, service);
        registerAgentRoutes(router, agents);
        registerApiKeyRoutes(router, keys);
        registerCredentialBindingRoutes(router, bindings);
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const send = (
    method: string,
    path: string,
    headers: HeadersInit,
    body?: unknown,
  ) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  async function errorOf(response: Response) {
    return apiErrorResponseSchema.parse(await response.json()).error;
  }

  let workspaceId = "";
  const cookies: Record<"owner" | "admin" | "other", string> = {
    owner: "",
    admin: "",
    other: "",
  };
  let adminId = "";
  let agentId = "";
  let releaseId = "";
  let agentKey = "";
  const bindingsPath = () => `/v1/agents/${agentId}/credential-bindings`;

  async function login(email: string) {
    const response = await send(
      "POST",
      "/v1/auth/login",
      { "X-Requested-With": "agent-platform-web" },
      { email, password: PASSWORD },
    );
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  async function addMember(email: string) {
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(PASSWORD, {
          algorithm: "argon2id",
        }),
        displayName: email,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    await db
      .insert(memberships)
      .values({ workspaceId, userId: user.id, role: "member" });
    return user.id;
  }

  function createSession(headers: HeadersInit, key = crypto.randomUUID()) {
    return send(
      "POST",
      "/v1/sessions",
      { ...headers, "Idempotency-Key": key },
      {
        profile_id: "claude-coding-v1",
        repository_id: "sample-app",
        message: "Summarise the minutes.",
        agent_release_id: releaseId,
      },
    );
  }

  const activate = (expected_revision: number) =>
    send("POST", `/v1/agents/${agentId}/activate`, asCookie(cookies.admin), {
      release_id: releaseId,
      expected_revision,
    });

  test("setup: an owner, a member who makes an agent naming a credential, another member", async () => {
    const boot = await send(
      "POST",
      "/v1/auth/bootstrap",
      {},
      {
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      },
    );
    expect(boot.status).toBe(201);
    workspaceId = bootstrapResponseSchema.parse(await boot.json()).workspace.id;
    cookies.owner = await login("owner@example.com");
    adminId = await addMember("agent-admin@example.com");
    await addMember("other@example.com");
    cookies.admin = await login("agent-admin@example.com");
    cookies.other = await login("other@example.com");

    const created = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "minutes",
      name: "minutes",
      card,
    });
    expect(created.status).toBe(201);
    const detail = (await created.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    agentId = detail.agent.id;
    const released = await send(
      "POST",
      `/v1/agents/${agentId}/releases`,
      asCookie(cookies.admin),
      {
        version_id: detail.versions[0]?.id,
        runtime_profile_id: "claude-coding-v1",
      },
    );
    expect(released.status).toBe(200);
    releaseId = createAgentReleaseResponseSchema.parse(await released.json())
      .release.id;

    const key = await send("POST", "/v1/api-keys", asCookie(cookies.admin), {
      kind: "service",
      agent_id: agentId,
      scopes: ["sessions:read", "sessions:write"],
    });
    expect(key.status).toBe(201);
    agentKey = createApiKeyResponseSchema.parse(await key.json()).secret;
  });

  test("activating a version whose name is unbound is refused with the missing names", async () => {
    const refused = await activate(-1);
    expect(refused.status).toBe(409);
    const error = await errorOf(refused);
    expect(error.code).toBe("CREDENTIAL_UNBOUND");
    expect(
      activationCredentialUnboundDetailsSchema.parse(error.details),
    ).toEqual({ reason_code: "credential_unbound", missing: [REF] });
  });

  test("a member who administers nothing and an API key, the agent's own, cannot bind", async () => {
    const body = { credential_ref: REF };
    const member = await send(
      "POST",
      bindingsPath(),
      asCookie(cookies.other),
      body,
    );
    expect(member.status).toBe(403);
    expect(await errorOf(member)).toMatchObject({
      details: { reason_code: "role" },
    });
    expect(
      (await send("GET", bindingsPath(), asCookie(cookies.other))).status,
    ).toBe(403);
    expect(
      (await send("POST", bindingsPath(), bearer(agentKey), body)).status,
    ).toBe(403);
    const denied = await db
      .select({ outcome: authzDecisions.outcome })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.action, "credential.bind"),
          eq(authzDecisions.workspaceId, workspaceId),
        ),
      );
    expect(denied.filter((row) => row.outcome === "deny").length).toBe(3);
  });

  let bindingId = "";

  test("the agent's admin binds the name, then activation goes through", async () => {
    const bound = await send("POST", bindingsPath(), asCookie(cookies.admin), {
      credential_ref: REF,
    });
    expect(bound.status).toBe(200);
    const created = createCredentialBindingResponseSchema.parse(
      await bound.json(),
    );
    expect(created).toMatchObject({
      created: true,
      binding: { credential_ref: REF, bound_by: adminId, running_sessions: 0 },
    });
    bindingId = created.binding.id;
    const [receipt] = await db
      .select({ operation: receipts.operation })
      .from(receipts)
      .where(eq(receipts.id, created.receipt_id ?? ""));
    expect(receipt?.operation).toBe("bind_credential");
    // Binding again is the same binding and writes nothing.
    const again = createCredentialBindingResponseSchema.parse(
      await (
        await send("POST", bindingsPath(), asCookie(cookies.admin), {
          credential_ref: REF,
        })
      ).json(),
    );
    expect(again).toMatchObject({ created: false, receipt_id: null });
    expect(again.binding.id).toBe(bindingId);

    expect((await activate(-1)).status).toBe(200);
  });

  test("unbinding counts the running session that keeps it, and the next session is refused before it starts", async () => {
    const runningKey = crypto.randomUUID();
    const running = await createSession(bearer(agentKey), runningKey);
    expect(running.status).toBe(201);
    const { session_id } = createSessionResponseSchema.parse(
      await running.json(),
    );

    const listed = listCredentialBindingsResponseSchema.parse(
      await (await send("GET", bindingsPath(), asCookie(cookies.owner))).json(),
    );
    expect(listed.items.map((item) => item.running_sessions)).toEqual([1]);
    expect(listed.revoke_notice).toBe(CREDENTIAL_REVOKE_NOTICE);

    const revoked = await send(
      "DELETE",
      `${bindingsPath()}/${bindingId}`,
      asCookie(cookies.admin),
    );
    expect(revoked.status).toBe(200);
    const body = revokeCredentialBindingResponseSchema.parse(
      await revoked.json(),
    );
    expect(body.binding.running_sessions).toBe(1);
    expect(body.binding.revoked_at).not.toBeNull();
    expect(body.revoke_notice).toBe(CREDENTIAL_REVOKE_NOTICE);
    expect(
      (
        await send(
          "DELETE",
          `${bindingsPath()}/${bindingId}`,
          asCookie(cookies.admin),
        )
      ).status,
    ).toBe(404);

    // The session accepted before the unbind is still its key's answer.
    const replayed = await createSession(bearer(agentKey), runningKey);
    expect(replayed.status).toBe(201);
    expect(
      createSessionResponseSchema.parse(await replayed.json()).session_id,
    ).toBe(session_id);

    for (const headers of [bearer(agentKey), asCookie(cookies.owner)]) {
      const refused = await createSession(headers);
      expect(refused.status).toBe(409);
      const error = await errorOf(refused);
      expect(error.code).toBe("CREDENTIAL_UNBOUND");
      const details = sessionCredentialUnboundDetailsSchema.parse(
        error.details,
      );
      expect(details).toEqual({
        reason_code: "credential_unbound",
        guidance: CREDENTIAL_UNBOUND_GUIDANCE,
        agent_id: agentId,
        admins: [
          {
            user_id: adminId,
            display_name: "agent-admin@example.com",
            email: "agent-admin@example.com",
          },
        ],
        admin_link: "mailto:agent-admin%40example.com",
        receipt_id: details.receipt_id,
      });
      const [receipt] = await db
        .select({ operation: receipts.operation, status: receipts.status })
        .from(receipts)
        .where(eq(receipts.id, details.receipt_id));
      expect(receipt).toEqual({
        operation: "create_session",
        status: "failed",
      });
      // The requester learns whom to ask, not which name is missing.
      expect(JSON.stringify(error)).not.toContain(REF);
    }
    const decisions = await db
      .select({ reason: authzDecisions.reasonCode })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.action, "session.submit"),
          eq(authzDecisions.workspaceId, workspaceId),
          eq(authzDecisions.outcome, "deny"),
        ),
      );
    // The replay's decision is a deny too: the policy cannot tell a replay.
    expect(decisions.map((row) => row.reason)).toEqual([
      "credential_unbound",
      "credential_unbound",
      "credential_unbound",
    ]);

    const appended = await send(
      "POST",
      `/v1/sessions/${session_id}/messages`,
      { ...bearer(agentKey), "Idempotency-Key": crypto.randomUUID() },
      { message: "And the next one.", mode: "enqueue" },
    );
    expect(appended.status).toBe(409);
    const appendError = await errorOf(appended);
    expect(appendError.code).toBe("CREDENTIAL_UNBOUND");
    const appendDetails = sessionCredentialUnboundDetailsSchema.parse(
      appendError.details,
    );
    const [appendReceipt] = await db
      .select({ operation: receipts.operation, status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, appendDetails.receipt_id));
    expect(appendReceipt).toEqual({
      operation: "append_message",
      status: "failed",
    });
  });
});
