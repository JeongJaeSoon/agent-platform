import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AGENT_GITHUB_ACTIVITY_LIMIT,
  type AgentGitHub,
  agentGitHubActivityResponseSchema,
  agentGitHubResponseSchema,
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createAgentReleaseResponseSchema,
  createApiKeyResponseSchema,
  githubSettingsResponseSchema,
  putAgentGitHubEnabledResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentGitHubStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresGitHubGateStore,
  createPostgresGitHubOAuthStore,
  createPostgresGitHubSettingsStore,
  createPostgresWorkspaceKeyStore,
  memberships,
  users,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAgentGitHubService,
  createAgentService,
  createApiKeyService,
  createAuthorizationPolicy,
  createGitHubSettingsService,
  type SessionCatalog,
  withSeededInstallation,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore, generateApiKey, hashApiKey } from "./keys.ts";
import { registerAgentGitHubRoutes } from "./routes/agent-github.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerApiKeyRoutes } from "./routes/api-keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerGitHubSettingsRoutes } from "./routes/github-settings.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "bootstrap-token-for-the-agent-github-tab";
const PASSWORD = "correct horse battery staple";

const catalog: SessionCatalog = withSeededInstallation({
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
      url: "https://github.com/acme/sample-app",
      branch: "main",
      profiles: ["claude-coding-v1"],
      auth: { kind: "github_app", registered: true },
    },
    "pat-app": {
      url: "https://github.com/acme/pat-app",
      branch: "main",
      profiles: ["claude-coding-v1"],
      auth: {
        kind: "basic",
        username: "x-access-token",
        value: "pat-value",
        ref: { value_env: "PAT" },
      },
    },
    "gitea-app": {
      url: "https://gitea.invalid/acme/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
    },
  },
});

const card = {
  role: "문의 분류",
  instructions: "들어온 문의를 분류한다.",
  language: "ko" as const,
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  rules: [],
};

const GITHUB: AgentGitHub = {
  repositories: ["sample-app"],
  push_approval: true,
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [{ workflow: "ci.yml", ref: "release/*" }],
};

// Design github-agent.md §6 and decision 10: the agent's GitHub tab reads
// its switch, settings and activity; activity is found by target and keeps
// sessions the caller cannot see out before the latest 20 are cut.
integration("agent GitHub tab over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_github_api" });
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
    const agentStore = createPostgresAgentStore(db);
    const githubSettings = createPostgresGitHubSettingsStore(db);
    const agents = createAgentService({
      authorization,
      store: agentStore,
      catalog,
      credentials,
      githubSettings,
    });
    const keys = createApiKeyService({
      authorization,
      store: createPostgresWorkspaceKeyStore(db),
      mint: () => {
        const secret = generateApiKey();
        return { secret, hash: hashApiKey(secret) };
      },
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
        registerAgentRoutes(router, agents);
        registerApiKeyRoutes(router, keys);
        registerGitHubSettingsRoutes(
          router,
          createGitHubSettingsService({
            authorization,
            store: githubSettings,
            oauth: createPostgresGitHubOAuthStore(db, null),
            callbackUrl: null,
            secretsOn: false,
          }),
        );
        registerAgentGitHubRoutes(
          router,
          createAgentGitHubService({
            authorization,
            agents: agentStore,
            store: createPostgresAgentGitHubStore(db),
            catalog,
            githubSettings,
          }),
        );
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
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });

  let workspaceId = "";
  let ownerId = "";
  let adminId = "";
  const cookies = { owner: "", admin: "", other: "" };
  let agentId = "";
  let versionId = "";
  let firstRelease = "";
  let githubRelease = "";

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

  async function release(body: object) {
    const response = await send(
      "POST",
      `/v1/agents/${agentId}/releases`,
      asCookie(cookies.admin),
      {
        runtime_profile_id: "claude-coding-v1",
        repository_id: "sample-app",
        ...body,
      },
    );
    expect(response.status).toBe(200);
    return createAgentReleaseResponseSchema.parse(await response.json());
  }

  async function activate(releaseId: string) {
    const detail = (await (
      await send("GET", `/v1/agents/${agentId}`, asCookie(cookies.admin))
    ).json()) as { agent: { activation_revision: number } };
    const response = await send(
      "POST",
      `/v1/agents/${agentId}/activate`,
      asCookie(cookies.admin),
      {
        release_id: releaseId,
        expected_revision: detail.agent.activation_revision,
      },
    );
    expect(response.status).toBe(200);
  }

  /** A session of `releaseId`; `privateTo` keeps it to its creator. */
  async function session(releaseId: string, createdBy: string, priv = false) {
    const sessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id)
       VALUES ($1, $2, 'https://github.com/acme/sample-app', 'main',
         'sample-app', $3, $4, $5)`,
      [sessionId, workspaceId, workspaceId, releaseId, createdBy],
    );
    if (priv) {
      await pool.query(
        `INSERT INTO session_shares (session_id, owner_id, workspace_id, scope, updated_by)
         VALUES ($1, $2, $3, 'private', $4)`,
        [sessionId, workspaceId, workspaceId, createdBy],
      );
    }
    return sessionId;
  }

  /** What the gate writes for a token, at `at` seconds from now. */
  async function minted(sessionId: string, at: number) {
    const id = await createPostgresGitHubGateStore(db).recordReceipt({
      ownerId: workspaceId,
      sessionId,
      actor: null,
      operation: "mint_github_token",
      status: "succeeded",
      result: { session_id: sessionId, purpose: "clone" },
      error: null,
    });
    await pool.query(
      "UPDATE receipts SET created_at = now() + make_interval(secs => $2) WHERE id = $1",
      [id, at],
    );
    return id;
  }

  const activity = async (cookie: string) => {
    const response = await send(
      "GET",
      `/v1/agents/${agentId}/github/activity`,
      asCookie(cookie),
    );
    expect(response.status).toBe(200);
    return agentGitHubActivityResponseSchema.parse(await response.json()).items;
  };

  test("setup: an owner turns Actions on under the ceiling; a member makes and releases an agent", async () => {
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
    const booted = bootstrapResponseSchema.parse(await boot.json());
    workspaceId = booted.workspace.id;
    ownerId = booted.user_id;
    cookies.owner = await login("owner@example.com");
    adminId = await addMember("agent-admin@example.com");
    await addMember("other@example.com");
    cookies.admin = await login("agent-admin@example.com");
    cookies.other = await login("other@example.com");

    const ceiling = await send(
      "PUT",
      `/v1/workspaces/${workspaceId}/github-settings`,
      asCookie(cookies.owner),
      { ceiling: { ...GITHUB.features }, revision: 0 },
    );
    expect(ceiling.status).toBe(200);
    expect(
      githubSettingsResponseSchema.parse(await ceiling.json()).ceiling.actions,
    ).toBe(true);

    const created = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "triage",
      name: "triage",
      card,
    });
    expect(created.status).toBe(201);
    const detail = (await created.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    agentId = detail.agent.id;
    versionId = detail.versions[0]?.id ?? "";
    firstRelease = (await release({ version_id: versionId })).release.id;
    await activate(firstRelease);
  });

  test("GET github: a release without settings reads legacy defaults and the options", async () => {
    const response = await send(
      "GET",
      `/v1/agents/${agentId}/github`,
      asCookie(cookies.admin),
    );
    expect(response.status).toBe(200);
    const body = agentGitHubResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      enabled: true,
      active_release_id: firstRelease,
      release_repository_id: "sample-app",
      github: null,
      unsavable: null,
      legacy_defaults: {
        repositories: ["sample-app"],
        push_approval: true,
        actions_allow: [],
      },
    });
    // Gitea is not GitHub; the PAT repository cannot be narrowed.
    expect(body.options.repositories).toEqual([
      {
        id: "pat-app",
        url: "https://github.com/acme/pat-app",
        available: false,
        reason: "app_required",
        installed: { author: null, reviewer: null },
      },
      {
        id: "sample-app",
        url: "https://github.com/acme/sample-app",
        available: true,
        reason: null,
        installed: { author: null, reviewer: null },
      },
    ]);
    expect(body.options.features.actions).toEqual({
      available: true,
      reason: null,
    });
    expect(body.options.features.checks).toEqual({
      available: false,
      reason: "over_workspace_ceiling",
    });
  });

  test("a member who does not manage the agent reads none of it", async () => {
    for (const path of ["github", "github/activity"]) {
      const response = await send(
        "GET",
        `/v1/agents/${agentId}/${path}`,
        asCookie(cookies.other),
      );
      expect(response.status).toBe(403);
    }
  });

  test("saving settings makes a release of the same card version; it and its activation are listed, a card-only release is not", async () => {
    const saved = await release({ version_id: versionId, github: GITHUB });
    expect(saved.created).toBe(true);
    expect(saved.release.version_id).toBe(versionId);
    expect(saved.release.policy_pins.github).toEqual(GITHUB);
    githubRelease = saved.release.id;
    await activate(githubRelease);

    const read = agentGitHubResponseSchema.parse(
      await (
        await send(
          "GET",
          `/v1/agents/${agentId}/github`,
          asCookie(cookies.admin),
        )
      ).json(),
    );
    expect(read.github).toEqual(GITHUB);
    expect(read.legacy_defaults).toBeNull();

    // A card edit's release keeps the settings: nothing GitHub moved.
    const edited = await send(
      "PATCH",
      `/v1/agents/${agentId}`,
      asCookie(cookies.admin),
      { card: { ...card, role: "문의 분류와 담당 제안" } },
    );
    expect(edited.status).toBe(200);
    const versions = (
      (await edited.json()) as {
        versions: { id: string; version_no: number }[];
      }
    ).versions;
    const newest = versions.reduce((a, b) =>
      a.version_no > b.version_no ? a : b,
    );
    const cardOnly = await release({ version_id: newest.id });
    expect(cardOnly.release.policy_pins.github).toEqual(GITHUB);
    await activate(cardOnly.release.id);

    const items = await activity(cookies.admin);
    expect(
      items.map((item) => [
        item.operation,
        (item.result as { release_id?: string }).release_id,
      ]),
    ).toEqual([
      ["activate_agent", githubRelease],
      ["create_agent_release", githubRelease],
    ]);
    expect(items[0]?.actor?.actor_user_id).toBe(adminId);
    expect(items[0]?.result).toMatchObject({
      github: GITHUB,
      github_changed: true,
      previous_release_id: firstRelease,
    });
  });

  test("the switch applies at once, is listed, and is a console act", async () => {
    const off = await send(
      "PUT",
      `/v1/agents/${agentId}/github/enabled`,
      asCookie(cookies.admin),
      { enabled: false },
    );
    expect(off.status).toBe(200);
    const saved = putAgentGitHubEnabledResponseSchema.parse(await off.json());
    expect(saved.enabled).toBe(false);
    expect(saved.receipt_id).not.toBeNull();

    // The same value again writes nothing.
    const again = await send(
      "PUT",
      `/v1/agents/${agentId}/github/enabled`,
      asCookie(cookies.admin),
      { enabled: false },
    );
    expect(
      putAgentGitHubEnabledResponseSchema.parse(await again.json()).receipt_id,
    ).toBeNull();

    const read = agentGitHubResponseSchema.parse(
      await (
        await send(
          "GET",
          `/v1/agents/${agentId}/github`,
          asCookie(cookies.admin),
        )
      ).json(),
    );
    expect(read.enabled).toBe(false);

    const [latest] = await activity(cookies.admin);
    expect(latest).toMatchObject({
      id: saved.receipt_id,
      operation: "set_agent_github",
      status: "succeeded",
      result: { agent_id: agentId, enabled: false },
      target_ref: {
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      },
    });
    expect(latest?.actor?.actor_user_id).toBe(adminId);

    const key = await send("POST", "/v1/api-keys", asCookie(cookies.admin), {
      kind: "personal",
      scopes: ["sessions:read"],
    });
    expect(key.status).toBe(201);
    const secret = createApiKeyResponseSchema.parse(await key.json()).secret;
    const byKey = await send(
      "PUT",
      `/v1/agents/${agentId}/github/enabled`,
      { Authorization: `Bearer ${secret}` },
      { enabled: true },
    );
    expect(byKey.status).toBe(403);
    const refused = apiErrorResponseSchema.parse(await byKey.json()).error;
    expect(refused.code).toBe("FORBIDDEN");
  });

  test("a private session nobody shared is kept from the agent's admin, and the 20 fill from what they can see", async () => {
    const visible = await session(githubRelease, adminId);
    const hidden = await session(githubRelease, ownerId, true);
    const seen: string[] = [];
    // The visible ones are older; the private ones crowd the latest.
    for (let i = 0; i < AGENT_GITHUB_ACTIVITY_LIMIT + 5; i += 1) {
      seen.push(await minted(visible, 100 + i));
    }
    const kept: string[] = [];
    for (let i = 0; i < AGENT_GITHUB_ACTIVITY_LIMIT + 5; i += 1) {
      kept.push(await minted(hidden, 1000 + i));
    }

    const admin = await activity(cookies.admin);
    expect(admin).toHaveLength(AGENT_GITHUB_ACTIVITY_LIMIT);
    expect(admin.every((item) => seen.includes(item.id))).toBe(true);
    expect(admin.map((item) => item.id)).toEqual(
      seen.slice(-AGENT_GITHUB_ACTIVITY_LIMIT).reverse(),
    );
    for (const item of admin) {
      expect(item.target_ref).toMatchObject({ session_id: visible });
    }

    // The session's creator sees their own private one.
    const owner = await activity(cookies.owner);
    expect(owner.map((item) => item.id)).toEqual(
      kept.slice(-AGENT_GITHUB_ACTIVITY_LIMIT).reverse(),
    );
  });

  test("another agent's sessions are not listed", async () => {
    const other = await send("POST", "/v1/agents", asCookie(cookies.admin), {
      slug: "other",
      name: "other",
      card,
    });
    const otherDetail = (await other.json()) as {
      agent: { id: string };
      versions: { id: string }[];
    };
    const otherRelease = await send(
      "POST",
      `/v1/agents/${otherDetail.agent.id}/releases`,
      asCookie(cookies.admin),
      {
        version_id: otherDetail.versions[0]?.id,
        runtime_profile_id: "claude-coding-v1",
        repository_id: "sample-app",
      },
    );
    const otherReleaseId = createAgentReleaseResponseSchema.parse(
      await otherRelease.json(),
    ).release.id;
    const foreign = await minted(await session(otherReleaseId, adminId), 5000);
    const items = await activity(cookies.admin);
    expect(items.map((item) => item.id)).not.toContain(foreign);
  });
});
