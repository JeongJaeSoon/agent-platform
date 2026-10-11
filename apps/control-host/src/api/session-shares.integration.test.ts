import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createSessionResponseSchema,
  listSessionsResponseSchema,
  type SessionShareScope,
} from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  authzDecisions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  createPostgresPendingRequests,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresUsageReader,
  memberships,
  memberTeamMembers,
  memberTeams,
  users,
} from "@agent-platform/db";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  createInterruptService,
  createPendingRequestService,
  createSessionService,
  createUsageService,
  type SessionCatalog,
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
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerInterruptRoutes } from "./routes/interrupt.ts";
import { registerPauseRoutes } from "./routes/pause.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerUsageRoutes } from "./routes/usage.ts";
import { PostgresSessionNotifier } from "./session-notifier.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
// Long enough that only the share change's NOTIFY can end a stream in time.
const KEEPALIVE_MS = 30_000;

const catalog: SessionCatalog = {
  profiles: {
    "claude-coding-v1": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
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

// Design 4.6 on every session surface: outside the share a session does not
// exist, owner and admin included.
integration("session share scopes over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let notifier: PostgresSessionNotifier;
  const sink = new MemoryLogSink();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_shares_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [sink] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger,
    };
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: createDatabaseAgentAuthority(db),
      sessions: createPostgresSessionShareStore(db),
      decisions: createPostgresDecisionLog(db),
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
    });
    notifier = new PostgresSessionNotifier(database.url, logger);
    await notifier.start();
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
        registerPauseRoutes(router, service);
        registerReceiptRoutes(router, service);
        registerUsageRoutes(
          router,
          createUsageService({
            authorization,
            reader: createPostgresUsageReader(db),
            limits: {
              executionSlotLimit: 10,
              queuedInputLimitPerSession: 1_000,
              storageLimitBytes: 1e15,
              maxTurnSeconds: 3600,
              sessionCostLimitUsd: 1_000,
              sessionTokenLimit: null,
              providerMaxRetries: 2,
            },
          }),
        );
        registerPendingRoutes(
          router,
          createPendingRequestService({
            authorization,
            store: createPostgresPendingRequests(db),
          }),
        );
        registerInterruptRoutes(
          router,
          createInterruptService({
            authorization,
            store: createPostgresTurnInterrupts(db),
          }),
        );
        registerEventRoutes(router, service, {
          wakeup: notifier,
          keepaliveMs: KEEPALIVE_MS,
          logger,
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await notifier?.close();
    await pool?.end();
    await database?.drop();
  });

  const send = async (
    method: string,
    path: string,
    headers: HeadersInit,
    body?: unknown,
  ): Promise<Response> =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  const codeOf = async (response: Response) =>
    apiErrorResponseSchema.parse(await response.json()).error;

  type Who = "owner" | "admin" | "creator" | "teammate" | "outsider";
  const cookies = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;
  let workspaceId = "";
  let teamId = "";
  let sessionId = "";
  let receiptId = "";

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

  async function addMember(who: Who, role: "admin" | "member") {
    const email = `${who}@example.com`;
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(PASSWORD, {
          algorithm: "argon2id",
        }),
        displayName: who,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    await db.insert(memberships).values({ workspaceId, userId: user.id, role });
    ids[who] = user.id;
    cookies[who] = await login(email);
  }

  function creator(): Caller {
    return callerFor(
      {
        kind: "user",
        id: ids.creator,
        workspace_id: workspaceId,
        role: "member",
        scopes: [
          "sessions:read",
          "sessions:write",
          "sessions:approve",
          "sessions:control",
        ],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
  }

  async function share(scope: SessionShareScope, teamIds: string[] = []) {
    const result = await createPostgresSessionShareStore(db).set({
      principal: creator(),
      ownerId: workspaceId,
      workspaceId,
      sessionId,
      scope,
      userIds: [],
      teamIds,
      updatedBy: ids.creator,
      receiptId: crypto.randomUUID(),
    });
    expect(result.outcome).toBe("changed");
  }

  const listed = async (who: Who, query = "") => {
    const response = await send(
      "GET",
      `/v1/sessions${query}`,
      asCookie(cookies[who]),
    );
    expect(response.status).toBe(200);
    return listSessionsResponseSchema
      .parse(await response.json())
      .items.map((item) => item.id);
  };

  // Every surface a session has, read or written.
  const surfaces: [string, (who: Who) => Promise<Response>][] = [
    [
      "detail",
      (who) => send("GET", `/v1/sessions/${sessionId}`, asCookie(cookies[who])),
    ],
    [
      "turns",
      (who) =>
        send("GET", `/v1/sessions/${sessionId}/turns`, asCookie(cookies[who])),
    ],
    [
      "turn",
      (who) =>
        send(
          "GET",
          `/v1/sessions/${sessionId}/turns/1`,
          asCookie(cookies[who]),
        ),
    ],
    [
      "events (SSE)",
      (who) =>
        send("GET", `/v1/sessions/${sessionId}/events`, asCookie(cookies[who])),
    ],
    [
      "usage",
      (who) =>
        send("GET", `/v1/sessions/${sessionId}/usage`, asCookie(cookies[who])),
    ],
    [
      "pending requests",
      (who) =>
        send(
          "GET",
          `/v1/sessions/${sessionId}/pending-requests`,
          asCookie(cookies[who]),
        ),
    ],
    [
      "receipt",
      (who) => send("GET", `/v1/receipts/${receiptId}`, asCookie(cookies[who])),
    ],
    [
      "message",
      (who) =>
        send(
          "POST",
          `/v1/sessions/${sessionId}/messages`,
          { ...asCookie(cookies[who]), "Idempotency-Key": crypto.randomUUID() },
          { message: "and the rest?" },
        ),
    ],
    [
      "approval",
      (who) =>
        send(
          "POST",
          `/v1/sessions/${sessionId}/answers`,
          { ...asCookie(cookies[who]), "Idempotency-Key": crypto.randomUUID() },
          { kind: "permission", request_id: "req_none", decision: "allow" },
        ),
    ],
    [
      "interrupt",
      (who) =>
        send(
          "POST",
          `/v1/sessions/${sessionId}/interrupt`,
          { ...asCookie(cookies[who]), "Idempotency-Key": crypto.randomUUID() },
          { target_turn_id: "1" },
        ),
    ],
  ];

  test("setup: owner, admin, the creator, a teammate in a team, an outsider; the creator's session", async () => {
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
    ids.owner = booted.user_id;
    cookies.owner = await login("owner@example.com");
    await addMember("admin", "admin");
    await addMember("creator", "member");
    await addMember("teammate", "member");
    await addMember("outsider", "member");
    teamId = crypto.randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: "research" });
    await db.insert(memberTeamMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      teamId,
      userId: ids.teammate,
    });

    const created = await send(
      "POST",
      "/v1/sessions",
      { ...asCookie(cookies.creator), "Idempotency-Key": crypto.randomUUID() },
      {
        profile_id: "claude-coding-v1",
        repository_id: "sample-app",
        message: "Summarise the minutes.",
      },
    );
    expect(created.status).toBe(201);
    const body = createSessionResponseSchema.parse(await created.json());
    sessionId = body.session_id;
    receiptId = body.receipt_id;
  });

  test("a workspace-wide session is everyone's", async () => {
    for (const who of ["owner", "teammate", "outsider"] as const) {
      expect(await listed(who)).toContain(sessionId);
    }
  });

  test("a private session is the creator's on every surface; everyone else, owner and admin included, gets not_found", async () => {
    await share("private");
    expect(await listed("creator")).toContain(sessionId);
    expect(await listed("creator", "?status=queued")).toContain(sessionId);
    for (const who of ["owner", "admin", "teammate", "outsider"] as const) {
      expect(await listed(who)).not.toContain(sessionId);
      expect(await listed(who, "?status=queued")).not.toContain(sessionId);
      for (const [surface, call] of surfaces) {
        const response = await call(who);
        expect({ who, surface, status: response.status }).toEqual({
          who,
          surface,
          status: 404,
        });
        expect((await codeOf(response)).code).toBe("NOT_FOUND");
      }
    }
    const detail = await surfaces[0]?.[1]("creator");
    expect(detail?.status).toBe(200);
    // Each refusal is a kept decision, the approval's included.
    const refusals = await db
      .select({ action: authzDecisions.action })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.resourceId, sessionId),
          eq(authzDecisions.reasonCode, "not_found"),
          eq(authzDecisions.actorUserId, ids.owner),
        ),
      );
    expect(new Set(refusals.map((row) => row.action))).toEqual(
      new Set([
        "session.read",
        "session.submit",
        "session.approve",
        "session.control",
      ]),
    );
  });

  test("shared with a team, its members see it and nobody else does", async () => {
    await share("team", [teamId]);
    expect(await listed("teammate")).toContain(sessionId);
    expect(await listed("outsider")).not.toContain(sessionId);
    const detail = await send(
      "GET",
      `/v1/sessions/${sessionId}`,
      asCookie(cookies.teammate),
    );
    expect(detail.status).toBe(200);
    const approval = await surfaces.find(([s]) => s === "approval")?.[1](
      "teammate",
    );
    // Past the share; the store then finds no such request.
    expect(approval?.status).toBe(404);
    const [allowed] = await db
      .select({ outcome: authzDecisions.outcome })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.resourceId, sessionId),
          eq(authzDecisions.action, "session.approve"),
          eq(authzDecisions.actorUserId, ids.teammate),
          eq(authzDecisions.outcome, "allow"),
        ),
      );
    expect(allowed?.outcome).toBe("allow");
    for (const [, call] of surfaces) {
      expect((await call("outsider")).status).toBe(404);
    }
  });

  test("narrowing the share ends the teammate's open stream, and it does not reopen", async () => {
    const response = await send(
      "GET",
      `/v1/sessions/${sessionId}/events`,
      asCookie(cookies.teammate),
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    // Let the stream reach its wait before narrowing.
    await Bun.sleep(200);
    const narrowedAt = Date.now();
    await share("private");
    let done = false;
    while (!done) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => null),
      ]);
      if (chunk === null) throw new Error("the stream outlived the narrowing");
      done = chunk.done;
    }
    expect(Date.now() - narrowedAt).toBeLessThan(KEEPALIVE_MS);
    expect(
      sink.records.some(
        (record) =>
          record.message === "SSE stream closed" &&
          record.fields?.reason === "not_visible",
      ),
    ).toBe(true);
    const reopened = await send(
      "GET",
      `/v1/sessions/${sessionId}/events`,
      asCookie(cookies.teammate),
    );
    expect(reopened.status).toBe(404);
  }, 20_000);

  test("out of the team is out of the share at the next request", async () => {
    await share("team", [teamId]);
    expect(await listed("teammate")).toContain(sessionId);
    await db
      .update(memberTeamMembers)
      .set({ removedAt: new Date() })
      .where(eq(memberTeamMembers.teamId, teamId));
    expect(await listed("teammate")).not.toContain(sessionId);
  });
});
