import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  loginResponseSchema,
  startGoogleLoginResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  invites,
  loginMethods,
  memberships,
  users,
  webSessions,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  hashWebSessionToken,
  LoginLockout,
} from "./auth.ts";
import { createGoogleLogin, type GoogleLoginConfig } from "./google-login.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
const CLIENT_ID = "client-id.apps.example";
const CLIENT_SECRET = "mock-client-secret";
const BROWSER = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

integration("Google sign-in first-entry rules on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let identity: DatabaseIdentityStore;
  let idp: MockOidcServer;
  let workspaceId = "";
  let ownerId = "";

  function appWith(google: Partial<GoogleLoginConfig> = {}) {
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger: new StructuredLogger({ sinks: [new MemoryLogSink()] }),
      google: createGoogleLogin({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: "https://werft.example/auth/google/callback",
        issuer: idp.issuer,
        allowedDomains: [],
        jit: false,
        ...google,
      }),
    };
    const app = createApiApp({
      authMode: "api-key",
      keyStore: { find: async () => null },
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => registerAuthRoutes(router, auth),
    });
    const post = (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...BROWSER, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const signIn = async (claims: MockOidcClaims) => {
      const started = await post("/v1/auth/google/start");
      expect(started.status).toBe(200);
      const flowCookie =
        (started.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
      const { authorization_url } = startGoogleLoginResponseSchema.parse(
        await started.json(),
      );
      const back = await idp.authorize(authorization_url, claims);
      return post("/v1/auth/google/callback", back, { Cookie: flowCookie });
    };
    return { app, post, signIn };
  }

  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${WEB_SESSION_COOKIE_NAME}=`))
      ?.split(";")[0] ?? "";
  const errorOf = async (response: Response) => {
    const { error } = await response.json();
    return { code: error.code, message: error.message };
  };
  const methodsOf = (userId: string) =>
    db.select().from(loginMethods).where(eq(loginMethods.userId, userId));
  const userByEmail = async (email: string) =>
    (await db.select().from(users).where(eq(users.email, email)))[0];
  const invite = async (email: string, role = "member", ttlMs = 60_000) => {
    const id = randomUUID();
    await db.insert(invites).values({
      id,
      workspaceId,
      email,
      role,
      tokenHash: hashWebSessionToken(randomUUID()),
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return id;
  };

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "google" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    identity = new DatabaseIdentityStore(db);
    idp = await startMockOidcServer({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const created = await appWith().post("/v1/auth/bootstrap", {
      bootstrap_token: BOOTSTRAP_TOKEN,
      email: "owner@example.com",
      password: PASSWORD,
      display_name: "Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    });
    expect(created.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await created.json());
    workspaceId = body.workspace.id;
    ownerId = body.user_id;
  }, 60_000);

  afterAll(async () => {
    idp?.stop();
    await pool?.end();
    await database?.drop();
  });

  test("bootstrap gives the owner a kind=password login method", async () => {
    const methods = await methodsOf(ownerId);
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({
      kind: "password",
      issuer: null,
      subject: null,
    });
  });

  test("rule 2: a live invite creates a passwordless account, accepts the invite and signs in", async () => {
    const inviteId = await invite("bob@example.com", "owner");
    const response = await appWith().signIn({
      sub: "sub-bob",
      email: "Bob@Example.com",
      hd: "example.com",
      name: "Bob",
    });
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ workspace_id: workspaceId, role: "owner" });
    const bob = await userByEmail("bob@example.com");
    expect(bob).toMatchObject({
      id: body.user_id,
      passwordHash: null,
      displayName: "Bob",
    });
    expect(await methodsOf(body.user_id)).toMatchObject([
      {
        kind: "google",
        issuer: idp.issuer,
        subject: "sub-bob",
        emailAtLink: "bob@example.com",
      },
    ]);
    const [accepted] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, inviteId));
    expect(accepted?.acceptedAt).not.toBeNull();
    const me = await appWith().app.request("/v1/auth/me", {
      headers: { Cookie: sessionCookie(response) },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("bob@example.com");
  });

  test("rule 2: an expired or revoked invite admits nobody", async () => {
    await invite("late@example.com", "member", -1_000);
    const response = await appWith().signIn({
      sub: "sub-late",
      email: "late@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(401);
    expect(await userByEmail("late@example.com")).toBeUndefined();
  });

  test("rule 1: a linked account signs in as its user, whatever address Google now reports", async () => {
    const bob = await userByEmail("bob@example.com");
    const response = await appWith().signIn({
      sub: "sub-bob",
      email: "bob.renamed@example.com",
    });
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    expect(body.user_id).toBe(bob?.id as string);
    expect(await db.$count(users)).toBe(2);
    const [method] = await methodsOf(body.user_id);
    expect(method?.lastLoginAt).not.toBeNull();
  });

  test("rule 1: a linked account of a disabled user is refused like an unknown one", async () => {
    await invite("carol@example.com");
    expect(
      (
        await appWith().signIn({
          sub: "sub-carol",
          email: "carol@example.com",
          hd: "example.com",
        })
      ).status,
    ).toBe(200);
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.email, "carol@example.com"));
    const response = await appWith().signIn({
      sub: "sub-carol",
      email: "carol@example.com",
    });
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual({
      code: "UNAUTHORIZED",
      message: "Google sign-in was not accepted",
    });
  });

  test("rule 3: JIT admits an allowed domain as a member of the workspace", async () => {
    const response = await appWith({
      allowedDomains: ["example.com"],
      jit: true,
    }).signIn({
      sub: "sub-dave",
      email: "dave@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ workspace_id: workspaceId, role: "member" });
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, body.user_id));
    expect(membership?.role).toBe("member");
  });

  test("rule 3: with JIT off the same account is refused", async () => {
    const response = await appWith({ allowedDomains: ["example.com"] }).signIn({
      sub: "sub-erin",
      email: "erin@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(401);
    expect(await userByEmail("erin@example.com")).toBeUndefined();
  });

  test("rule 4: an address that has an account is never joined by email, invite or JIT notwithstanding", async () => {
    await invite("owner@example.com");
    const sessionsBefore = await db.$count(webSessions);
    const response = await appWith({
      allowedDomains: ["example.com"],
      jit: true,
    }).signIn({
      sub: "sub-impostor",
      email: "owner@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({
      code: "LOGIN_LINK_REQUIRED",
      message:
        "Sign in with your existing account, then connect Google in settings",
    });
    expect(sessionCookie(response)).toBe("");
    expect(await db.$count(webSessions)).toBe(sessionsBefore);
    expect(await methodsOf(ownerId)).toHaveLength(1);
    expect(
      await db.$count(loginMethods, eq(loginMethods.subject, "sub-impostor")),
    ).toBe(0);
  });

  test("rule 5: refusals read the same whether or not an account exists", async () => {
    const google = appWith();
    const unknown = await google.signIn({
      sub: "sub-nobody",
      email: "nobody@example.com",
    });
    const disabled = await google.signIn({
      sub: "sub-carol",
      email: "carol@example.com",
    });
    const unverified = await google.signIn({
      sub: "sub-x",
      email: "owner@example.com",
      email_verified: false,
    });
    for (const response of [unknown, disabled, unverified]) {
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toEqual({
        code: "UNAUTHORIZED",
        message: "Google sign-in was not accepted",
      });
    }
    expect(await userByEmail("nobody@example.com")).toBeUndefined();
  });

  test("a domain restriction admits only accounts Google places in that domain", async () => {
    const restricted = appWith({ allowedDomains: ["example.com"] });
    for (const claims of [
      { sub: "sub-bob", email: "bob@example.com", hd: "other.example" },
      { sub: "sub-bob", email: "bob@example.com" },
    ]) {
      const response = await restricted.signIn(claims);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "FORBIDDEN" },
      });
    }
    expect(
      (
        await restricted.signIn({
          sub: "sub-bob",
          email: "bob@example.com",
          hd: "example.com",
        })
      ).status,
    ).toBe(200);
  });

  test("password login of a passwordless account fails exactly like a wrong password", async () => {
    const { post } = appWith();
    const passwordless = await post("/v1/auth/login", {
      email: "bob@example.com",
      password: PASSWORD,
    });
    const wrong = await post("/v1/auth/login", {
      email: "owner@example.com",
      password: "an adequately wrong password",
    });
    expect(passwordless.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await errorOf(passwordless)).toEqual(await errorOf(wrong));
    expect(sessionCookie(passwordless)).toBe("");
  });

  test("an owner cannot issue a reset link for a passwordless account", async () => {
    const { app, post } = appWith();
    const login = await post("/v1/auth/login", {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    const bob = await userByEmail("bob@example.com");
    const response = await app.request(
      `/v1/workspaces/${workspaceId}/members/${bob?.id}/password-reset`,
      {
        method: "POST",
        headers: {
          ...BROWSER,
          "Content-Type": "application/json",
          Cookie: sessionCookie(login),
        },
        body: JSON.stringify({ current_password: PASSWORD }),
      },
    );
    expect(response.status).toBe(404);
  });

  test("rule 2: only an address Google still vouches for (its Workspace domain or gmail.com) takes an invite", async () => {
    await invite("ivy@example.com");
    const stale = await appWith().signIn({
      sub: "sub-ivy",
      email: "ivy@example.com",
    });
    expect(stale.status).toBe(401);
    expect(await userByEmail("ivy@example.com")).toBeUndefined();
    const elsewhere = await appWith().signIn({
      sub: "sub-ivy",
      email: "ivy@example.com",
      hd: "other.example",
    });
    expect(elsewhere.status).toBe(401);
    await invite("gina@gmail.com");
    expect(
      (await appWith().signIn({ sub: "sub-gina", email: "gina@gmail.com" }))
        .status,
    ).toBe(200);
  });

  test("an address Google does not vouch for learns nothing about the account that has it", async () => {
    const response = await appWith().signIn({
      sub: "sub-former-owner",
      email: "owner@example.com",
    });
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual({
      code: "UNAUTHORIZED",
      message: "Google sign-in was not accepted",
    });
  });

  test("an invite that expires while another transaction holds it admits nobody", async () => {
    const inviteId = await invite("jo@example.com", "member", 300);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM invites WHERE id = $1 FOR UPDATE", [
        inviteId,
      ]);
      const pending = appWith().signIn({
        sub: "sub-jo",
        email: "jo@example.com",
        hd: "example.com",
      });
      await Bun.sleep(600);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(401);
    } finally {
      holder.release();
    }
    expect(await userByEmail("jo@example.com")).toBeUndefined();
  });

  test("two Google accounts claiming one address at once make one account", async () => {
    const google = appWith({ allowedDomains: ["example.com"], jit: true });
    const responses = await Promise.all(
      ["sub-kim-1", "sub-kim-2"].map((sub) =>
        google.signIn({ sub, email: "kim@example.com", hd: "example.com" }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });

  test("two first logins of one Google account at once make one account", async () => {
    await invite("frank@example.com");
    const frank = {
      sub: "sub-frank",
      email: "frank@example.com",
      hd: "example.com",
    };
    const google = appWith();
    const responses = await Promise.all([
      google.signIn(frank),
      google.signIn(frank),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const ids = await Promise.all(
      responses.map(async (r) => loginResponseSchema.parse(await r.json())),
    );
    expect(ids[0]?.user_id).toBe(ids[1]?.user_id as string);
    expect(
      await db.$count(
        loginMethods,
        and(
          eq(loginMethods.kind, "google"),
          eq(loginMethods.subject, "sub-frank"),
        ),
      ),
    ).toBe(1);
  });
});
