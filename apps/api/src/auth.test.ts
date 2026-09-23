import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  authMeResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  loginResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@agent-platform/contracts";
import type {
  BootstrapInput,
  ResolvedWebSession,
  UserRow,
  WorkspaceRow,
} from "@agent-platform/db";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import { BODY_IDLE_TIMEOUT_SECONDS, createApiApp } from "./app.ts";
import {
  bootstrapGateFromEnv,
  createBootstrapGate,
  csrfViolation,
  hashPassword,
  hashWebSessionToken,
  type IdentityStore,
  LoginLockout,
  legacyApiKeyPrincipal,
  WEB_SESSION_TTL_MS,
  WEB_SESSIONS_PER_USER,
  WorkGate,
} from "./auth.ts";
import {
  REQUEST_IDLE_TIMEOUT_SECONDS,
  RESPONSE_IDLE_TIMEOUT_SECONDS,
} from "./deadline.ts";
import { hashApiKey } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";

// In-memory identity store with the same null/row semantics as the SQL
// helpers; the integration test covers the real queries.
class MemoryIdentityStore implements IdentityStore {
  users: UserRow[] = [];
  workspaces: WorkspaceRow[] = [];
  memberships: Array<{
    workspaceId: string;
    userId: string;
    role: "owner" | "member";
    disabledAt: Date | null;
  }> = [];
  sessions: Array<{
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
    lastSeenAt: Date | null;
    renewals: number;
  }> = [];
  now = () => Date.now();

  async countUsers() {
    return this.users.length;
  }
  async bootstrap(input: BootstrapInput) {
    if (this.users.length > 0) {
      const { BootstrapDoneError } = await import("@agent-platform/db");
      throw new BootstrapDoneError();
    }
    const user: UserRow = {
      id: input.userId,
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      createdAt: new Date(this.now()),
      disabledAt: null,
    };
    const workspace: WorkspaceRow = {
      id: input.workspaceId,
      slug: input.workspaceSlug,
      name: input.workspaceName,
      settings: {},
      createdAt: new Date(this.now()),
    };
    this.users.push(user);
    this.workspaces.push(workspace);
    this.memberships.push({
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
      disabledAt: null,
    });
    return { user, workspace };
  }
  async findUserForLogin(email: string) {
    return (
      this.users.find((u) => u.email === email && u.disabledAt === null) ?? null
    );
  }
  async findLiveMembership(userId: string) {
    const row = this.memberships.find(
      (m) => m.userId === userId && m.disabledAt === null,
    );
    return row ? { workspaceId: row.workspaceId, role: row.role } : null;
  }
  async findWorkspace(workspaceId: string) {
    return this.workspaces.find((w) => w.id === workspaceId) ?? null;
  }
  async createWebSession(input: {
    id: string;
    userId: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  }) {
    const expiresAt = new Date(this.now() + input.ttlMs);
    const mine = this.sessions.filter(
      (s) =>
        s.userId === input.userId &&
        s.revokedAt === null &&
        s.expiresAt.getTime() > this.now(),
    );
    const dropped = new Set(
      mine.slice(0, Math.max(0, mine.length - input.maxLive + 1)),
    );
    this.sessions = this.sessions.filter(
      (s) =>
        s.userId !== input.userId ||
        (!dropped.has(s) &&
          s.revokedAt === null &&
          s.expiresAt.getTime() > this.now()),
    );
    this.sessions.push({
      id: input.id,
      userId: input.userId,
      tokenHash: Buffer.from(input.tokenHash).toString("hex"),
      expiresAt,
      revokedAt: null,
      lastSeenAt: new Date(this.now()),
      renewals: 0,
    });
    return { expiresAt };
  }
  async resolveWebSession(
    tokenHash: Uint8Array,
  ): Promise<ResolvedWebSession | null> {
    const hex = Buffer.from(tokenHash).toString("hex");
    const session = this.sessions.find(
      (s) =>
        s.tokenHash === hex &&
        s.revokedAt === null &&
        s.expiresAt.getTime() > this.now(),
    );
    if (!session) return null;
    const user = this.users.find(
      (u) => u.id === session.userId && u.disabledAt === null,
    );
    const membership = user ? await this.findLiveMembership(user.id) : null;
    if (!user || !membership) return null;
    return {
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      workspaceId: membership.workspaceId,
      role: membership.role,
      expiresAt: session.expiresAt,
    };
  }
  async renewWebSession(
    sessionId: string,
    ttlMs: number,
    renewAfterMs: number,
  ): Promise<Date | null> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session || session.revokedAt !== null) return null;
    if (
      session.lastSeenAt === null ||
      session.lastSeenAt.getTime() < this.now() - renewAfterMs
    ) {
      session.expiresAt = new Date(this.now() + ttlMs);
      session.lastSeenAt = new Date(this.now());
      session.renewals += 1;
      return session.expiresAt;
    }
    return null;
  }
  async revokeWebSession(tokenHash: Uint8Array) {
    const hex = Buffer.from(tokenHash).toString("hex");
    for (const session of this.sessions) {
      if (session.tokenHash === hex && session.revokedAt === null) {
        session.revokedAt = new Date(this.now());
      }
    }
  }
}

const BOOTSTRAP_TOKEN = "t".repeat(40);
const PASSWORD = "correct horse battery staple";
const WRONG = "not the password at all";
const API_KEY = "csp_test-key";

function harness(
  options: {
    authMode?: string;
    lockout?: LoginLockout;
    passwordWork?: WorkGate;
  } = {},
) {
  const identity = new MemoryIdentityStore();
  const sink = new MemoryLogSink();
  const logger = new StructuredLogger({ sinks: [sink] });
  const hooks: { beforeReauth?: () => void } = {};
  const auth = {
    identity,
    bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
    logger,
    ...(options.lockout ? { lockout: options.lockout } : {}),
    ...(options.passwordWork ? { passwordWork: options.passwordWork } : {}),
  };
  const app = createApiApp({
    authMode: options.authMode ?? "api-key",
    logger,
    identity,
    keyStore: {
      async findOwner(hash) {
        return Buffer.from(hash).equals(Buffer.from(hashApiKey(API_KEY)))
          ? "key-owner"
          : null;
      },
    },
    registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
    registerRoutes: (router) => {
      registerAuthRoutes(router, auth);
      router.get("/whoami", (context) =>
        context.json({
          owner_id: context.get("ownerId"),
          principal: context.get("principal"),
        }),
      );
      router.post("/mutate", (context) =>
        context.json({ owner_id: context.get("ownerId") }, 201),
      );
      // What SSE does on its clock: re-check the admitted credential.
      router.get("/reauth", async (context) => {
        hooks.beforeReauth?.();
        return context.json({ ok: await context.get("reauthenticate")() });
      });
    },
  });
  const json = (path: string, body: unknown, headers: HeadersInit = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const bootstrap = (overrides: Record<string, unknown> = {}) =>
    json("/v1/auth/bootstrap", {
      bootstrap_token: BOOTSTRAP_TOKEN,
      email: "Owner@Example.com",
      password: PASSWORD,
      display_name: "Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
      ...overrides,
    });
  const login = (email = "owner@example.com", password = PASSWORD) =>
    json("/v1/auth/login", { email, password }, BROWSER);
  return { app, identity, sink, json, bootstrap, login, hooks };
}

const BROWSER = { "X-Requested-With": "agent-platform-web" };

function cookieOf(response: Response): string {
  const header = response.headers.get("Set-Cookie");
  if (!header) throw new Error("no Set-Cookie");
  return header.split(";")[0] ?? "";
}

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("bootstrap", () => {
  test("creates the first owner once, then answers 409 BOOTSTRAP_DONE", async () => {
    const h = harness();
    const first = await h.bootstrap();
    expect(first.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await first.json());
    expect(body.role).toBe("owner");
    expect(body.workspace.slug).toBe("acme");
    expect(h.identity.users[0]?.email).toBe("owner@example.com");
    expect(h.identity.users[0]?.passwordHash).not.toContain(PASSWORD);

    const second = await h.bootstrap();
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("BOOTSTRAP_DONE");
  });

  test("refuses a missing or wrong token with 401 and keeps the token spendable", async () => {
    const h = harness();
    expect((await h.bootstrap({ bootstrap_token: undefined })).status).toBe(
      401,
    );
    expect(
      (await h.bootstrap({ bootstrap_token: "x".repeat(40) })).status,
    ).toBe(401);
    expect(h.identity.users).toHaveLength(0);
    expect((await h.bootstrap()).status).toBe(201);
  });

  test("a failed insert releases the token for another try", async () => {
    const h = harness();
    const original = h.identity.bootstrap.bind(h.identity);
    let fail = true;
    h.identity.bootstrap = async (input) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error("connection terminated"), {
          code: "ECONNRESET",
        });
      }
      return original(input);
    };
    expect((await h.bootstrap()).status).toBe(503);
    expect((await h.bootstrap()).status).toBe(201);
  });

  test("answers 401 before 400: the token is checked before the body", async () => {
    const h = harness();
    const invalidBody = { password: "x", workspace_slug: "Not A Slug" };
    // Wrong, missing or non-string token with an invalid body: 401, not 400.
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: "y".repeat(40) }))
        .status,
    ).toBe(401);
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: undefined }))
        .status,
    ).toBe(401);
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: 42 })).status,
    ).toBe(401);
    // Right token, invalid body: 400, and the token is not spent.
    expect((await h.bootstrap(invalidBody)).status).toBe(400);
    expect((await h.bootstrap()).status).toBe(201);
    // Done beats everything, including a wrong token and an invalid body.
    expect(
      (await h.bootstrap({ ...invalidBody, bootstrap_token: "y".repeat(40) }))
        .status,
    ).toBe(409);
  });

  test("two concurrent bootstraps with the right token create one owner", async () => {
    const h = harness();
    const statuses = (await Promise.all([h.bootstrap(), h.bootstrap()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(h.identity.users).toHaveLength(1);
  });

  test("a generated token is printed once, only while users are 0", async () => {
    const identity = new MemoryIdentityStore();
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const printed: string[] = [];
    const print = (line: string) => printed.push(line);
    const gate = await bootstrapGateFromEnv(undefined, identity, logger, print);
    expect(printed).toHaveLength(1);
    const token = printed[0]?.replace("BOOTSTRAP_TOKEN=", "") ?? "";
    expect(token).toHaveLength(43);
    expect(JSON.stringify(sink.records)).not.toContain(token);
    expect(gate.consume(token)).toBe(true);
    expect(gate.consume(token)).toBe(false);

    identity.users.push({} as UserRow);
    printed.length = 0;
    await bootstrapGateFromEnv(undefined, identity, logger, print);
    expect(printed).toHaveLength(0);

    const given = await bootstrapGateFromEnv(
      "g".repeat(32),
      identity,
      logger,
      print,
    );
    expect(printed).toHaveLength(0);
    expect(given.consume("g".repeat(32))).toBe(true);

    // A configured token the request schema would refuse can never be
    // presented, so it is a startup error rather than a silent dead install.
    await expect(
      bootstrapGateFromEnv("short", identity, logger, print),
    ).rejects.toThrow(/BOOTSTRAP_TOKEN/);
  });

  test("an unreachable database does not stop startup; the value is printed since users is unknown", async () => {
    const identity = new MemoryIdentityStore();
    identity.countUsers = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
        code: "ECONNREFUSED",
      });
    };
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const printed: string[] = [];
    const gate = await bootstrapGateFromEnv(
      undefined,
      identity,
      logger,
      (line) => printed.push(line),
    );
    expect(printed).toHaveLength(1);
    const value = printed[0]?.replace("BOOTSTRAP_TOKEN=", "") ?? "";
    expect(JSON.stringify(sink.records)).not.toContain(value);
    expect(gate.matches(value)).toBe(true);
  });

  test("an empty BOOTSTRAP_TOKEN refuses to start instead of generating one", async () => {
    const identity = new MemoryIdentityStore();
    let counted = 0;
    identity.countUsers = async () => {
      counted += 1;
      return 0;
    };
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
    const printed: string[] = [];
    await expect(
      bootstrapGateFromEnv("", identity, logger, (line) => printed.push(line)),
    ).rejects.toThrow(/BOOTSTRAP_TOKEN/);
    expect(counted).toBe(0);
    expect(printed).toHaveLength(0);
  });
});

describe("login, logout, me", () => {
  test("sets an HttpOnly Secure SameSite=Lax cookie and stores only the hash", async () => {
    const h = harness();
    await h.bootstrap();
    const response = await h.login("OWNER@example.com");
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    expect(body.role).toBe("owner");
    expect(body.scopes).toContain("sessions:recover");
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toStartWith(`${WEB_SESSION_COOKIE_NAME}=aps_`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    const token = cookieOf(response).split("=")[1] ?? "";
    expect(h.identity.sessions[0]?.tokenHash).toBe(
      Buffer.from(hashWebSessionToken(token)).toString("hex"),
    );
    expect(JSON.stringify(h.identity.sessions)).not.toContain(token);
    expect(
      (h.identity.sessions[0]?.expiresAt.getTime() ?? 0) - Date.now(),
    ).toBeGreaterThan(WEB_SESSION_TTL_MS - 5_000);
  });

  test("a wrong password and an unknown email answer the same 401", async () => {
    const h = harness();
    await h.bootstrap();
    const wrong = await h.login("owner@example.com", "not the password");
    const unknown = await h.login("nobody@example.com", PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = await wrong.json();
    const b = await unknown.json();
    expect(a.error.message).toBe(b.error.message);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
  });

  test("a disabled account or membership cannot log in", async () => {
    const h = harness();
    await h.bootstrap();
    const membership = h.identity.memberships[0];
    const user = h.identity.users[0];
    if (!membership || !user) throw new Error("bootstrap left no rows");
    membership.disabledAt = new Date();
    expect((await h.login()).status).toBe(401);
    membership.disabledAt = null;
    user.disabledAt = new Date();
    expect((await h.login()).status).toBe(401);
  });

  test("me returns the user principal, user and workspace; logout revokes", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());

    const me = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    const body = authMeResponseSchema.parse(await me.json());
    expect(body.principal.kind).toBe("user");
    expect(body.user?.email).toBe("owner@example.com");
    expect(body.workspace?.slug).toBe("acme");
    expect(body.workspace?.settings.kill_switch).toBe(false);

    const noHeader = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(noHeader.status).toBe(403);

    const logout = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(h.identity.sessions[0]?.revokedAt).not.toBeNull();

    const after = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(after.status).toBe(401);
  });

  test("me for an API key has no user and no workspace", async () => {
    const h = harness();
    const me = await h.app.request("/v1/auth/me", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(me.status).toBe(200);
    const body = authMeResponseSchema.parse(await me.json());
    expect(body.principal).toEqual(legacyApiKeyPrincipal("key-owner"));
    expect(body.user).toBeNull();
    expect(body.workspace).toBeNull();

    const logout = await h.app.request("/v1/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(logout.status).toBe(403);
  });

  test("an expired session is refused; an active one slides its expiry", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const session = h.identity.sessions[0];
    if (!session) throw new Error("login left no session");
    const start = Date.now();
    h.identity.now = () => start + 2 * 60 * 60 * 1000;
    const later = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(later.status).toBe(200);
    expect(session.renewals).toBe(1);
    expect(session.expiresAt.getTime()).toBe(
      start + 2 * 60 * 60 * 1000 + WEB_SESSION_TTL_MS,
    );
    // The browser's copy slides too: same token, the row's new Expires.
    const reissued = later.headers.get("Set-Cookie") ?? "";
    expect(reissued.split(";")[0]).toBe(cookie);
    expect(reissued).toContain(`Expires=${session.expiresAt.toUTCString()}`);
    expect(reissued).toContain("HttpOnly");
    // A second hit inside the renew window writes nothing and sets nothing.
    const quiet = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(session.renewals).toBe(1);
    expect(quiet.headers.get("Set-Cookie")).toBeNull();

    h.identity.now = () => session.expiresAt.getTime() + 1;
    const expired = await h.app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(expired.status).toBe(401);
  });
});

describe("login lockout", () => {
  test("holds at most maxKeys addresses, evicting the least recently failed", () => {
    let now = 0;
    const lockout = new LoginLockout({ maxKeys: 3, now: () => now });
    for (const key of ["a", "b", "c"]) {
      now += 1;
      lockout.recordFailure(key);
    }
    expect(lockout.size).toBe(3);
    now += 1;
    lockout.recordFailure("a"); // a becomes the most recent
    now += 1;
    lockout.recordFailure("d"); // evicts b, the least recently failed
    expect(lockout.size).toBe(3);
    for (let i = 0; i < 4; i += 1) lockout.recordFailure("b");
    expect(lockout.retryAfterMs("b")).toBe(0); // b restarted from zero
    for (let i = 0; i < 4; i += 1) lockout.recordFailure("a");
    expect(lockout.retryAfterMs("a")).toBeGreaterThan(0); // a kept its two
  });

  test("a concurrent burst cannot run more guesses than the limit", async () => {
    const lockout = new LoginLockout({ now: () => 1_000_000 });
    const h = harness({ lockout });
    await h.bootstrap();
    const statuses = (
      await Promise.all(
        Array.from({ length: 12 }, () => h.login("owner@example.com", WRONG)),
      )
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  test("a storage outage does not spend the budget, even in a concurrent burst", async () => {
    const lockout = new LoginLockout({ now: () => 1_000_000 });
    const h = harness({ lockout });
    await h.bootstrap();
    const findUserForLogin = h.identity.findUserForLogin;
    h.identity.findUserForLogin = async () => {
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    };
    const outage = (
      await Promise.all(
        Array.from({ length: 12 }, () => h.login("owner@example.com", WRONG)),
      )
    ).map((r) => r.status);
    // Every attempt is 503 and gives its reservation back; the password
    // work gate keeps fewer than five in flight, so none sees the window
    // closed either.
    expect(outage).toEqual(Array.from({ length: 12 }, () => 503));
    expect(lockout.size).toBe(0);

    h.identity.findUserForLogin = findUserForLogin;
    for (let i = 0; i < 5; i += 1) {
      expect((await h.login("owner@example.com", WRONG)).status).toBe(401);
    }
    expect((await h.login()).status).toBe(429);
  });

  test("distinct unknown emails cannot run more password work than the gate admits", async () => {
    const lockout = new LoginLockout({ now: () => 1_000_000 });
    const h = harness({ lockout, passwordWork: new WorkGate(1, 2) });
    await h.bootstrap();
    let inFlight = 0;
    let peak = 0;
    let lookups = 0;
    const findUserForLogin = h.identity.findUserForLogin.bind(h.identity);
    h.identity.findUserForLogin = async (email: string) => {
      lookups += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      try {
        return await findUserForLogin(email);
      } finally {
        inFlight -= 1;
      }
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.login(`nobody-${i}@example.com`, WRONG),
      ),
    );
    const statuses = responses.map((r) => r.status);
    // One running and two queued; the other seven are shed before any
    // lookup or hash, and do not count against their address.
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(peak).toBe(1);
    expect(lookups).toBe(3);
    expect(lockout.size).toBe(3);
    const shed = responses.find((r) => r.status === 429);
    expect(shed?.headers.get("Retry-After")).toBe("1");
    // Slots come back: the owner can log in afterwards.
    expect((await h.login()).status).toBe(200);
  });

  test("WorkGate admits up to its limit, queues up to maxQueued, refuses the rest", async () => {
    const gate = new WorkGate(2, 1);
    const first = await gate.tryAcquire();
    const second = await gate.tryAcquire();
    const third = gate.tryAcquire();
    expect(third).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(1);
    first?.();
    first?.();
    const releaseThird = await third;
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(0);
    second?.();
    releaseThird?.();
    expect(gate.running).toBe(0);
  });

  test("release gives back only its own attempt and is a no-op after clear", () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ attempts: 2, now: () => now });
    const first = lockout.reserve("a");
    now += 1;
    const second = lockout.reserve("a");
    expect(lockout.reserve("a").retryAfterMs).toBeGreaterThan(0);
    first.release();
    first.release();
    const third = lockout.reserve("a");
    expect(third.retryAfterMs).toBe(0);
    lockout.clear("a");
    second.release();
    third.release();
    expect(lockout.size).toBe(0);
    expect(lockout.reserve("a").retryAfterMs).toBe(0);
  });

  test("the sixth failed attempt inside the window is 429, and success clears it", async () => {
    let now = 1_000_000;
    const lockout = new LoginLockout({ now: () => now });
    const h = harness({ lockout });
    await h.bootstrap();
    for (let i = 0; i < 5; i += 1) {
      expect((await h.login("owner@example.com", WRONG)).status).toBe(401);
    }
    const sixth = await h.login("owner@example.com", WRONG);
    expect(sixth.status).toBe(429);
    expect(await errorCode(sixth)).toBe("RATE_LIMITED");
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The right password is refused too while locked.
    expect((await h.login()).status).toBe(429);
    // Another address is not affected.
    expect((await h.login("other@example.com", WRONG)).status).toBe(401);

    now += 15 * 60 * 1000 + 1;
    expect((await h.login()).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      await h.login("owner@example.com", WRONG);
    }
    expect((await h.login()).status).toBe(429);
  });
});

describe("principal middleware", () => {
  test("bearer wins over a cookie, and a bad bearer is not rescued by a valid cookie", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const workspaceId = h.identity.workspaces[0]?.id;

    const cookieOnly = await h.app.request("/v1/whoami", {
      headers: { Cookie: cookie },
    });
    expect(await cookieOnly.json()).toMatchObject({
      owner_id: workspaceId,
      principal: { kind: "user", workspace_id: workspaceId, role: "owner" },
    });

    const bearerOnly = await h.app.request("/v1/whoami", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(await bearerOnly.json()).toMatchObject({
      owner_id: "key-owner",
      principal: { kind: "api_key", id: "key-owner", workspace_id: null },
    });

    const both = await h.app.request("/v1/whoami", {
      headers: { Authorization: `Bearer ${API_KEY}`, Cookie: cookie },
    });
    expect(await both.json()).toMatchObject({ owner_id: "key-owner" });

    const badBearer = await h.app.request("/v1/whoami", {
      headers: { Authorization: "Bearer csp_wrong", Cookie: cookie },
    });
    expect(badBearer.status).toBe(401);

    // A present but empty, malformed or non-Bearer header is not a missing
    // one: the cookie must not stand in for it.
    for (const authorization of [
      "",
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer ",
      `Bearer ${API_KEY} extra`,
    ]) {
      const response = await h.app.request("/v1/whoami", {
        headers: { Authorization: authorization, Cookie: cookie },
      });
      expect(response.status, JSON.stringify(authorization)).toBe(401);
    }

    expect((await h.app.request("/v1/whoami")).status).toBe(401);
    expect(
      (
        await h.app.request("/v1/whoami", {
          headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=aps_forged` },
        })
      ).status,
    ).toBe(401);

    // A sibling subdomain can set `ap_session` with Domain and a longer Path,
    // which browsers send first; it cannot set the `__Host-` name, so the
    // planted cookie is simply not ours.
    expect(WEB_SESSION_COOKIE_NAME).toStartWith("__Host-");
    const shadowed = await h.app.request("/v1/whoami", {
      headers: { Cookie: `ap_session=aps_planted; ${cookie}` },
    });
    expect(shadowed.status).toBe(200);
    expect(await shadowed.json()).toMatchObject({
      principal: { kind: "user", workspace_id: workspaceId },
    });
  });

  test("routes outside the public allowlist stay 401 without credentials", async () => {
    const h = harness();
    expect((await h.app.request("/v1/auth/me")).status).toBe(401);
    expect(
      (await h.app.request("/v1/auth/logout", { method: "POST" })).status,
    ).toBe(401);
    expect((await h.app.request("/v1/sessions")).status).toBe(401);
    // Public routes do not need credentials, and an unknown /v1/auth path is
    // not public just by prefix.
    expect((await h.login("x@example.com", "p".repeat(12))).status).toBe(401);
    expect((await h.app.request("/v1/auth/other")).status).toBe(401);
  });

  test("an unauthenticated POST to a protected route is refused before its body is read", async () => {
    const h = harness();
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };
    let pulled = 0;
    // A body that never finishes: reading it would hang the request.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const response = await h.app.request(
      "/v1/mutate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit,
      env,
    );
    expect(response.status).toBe(401);
    // The deadline's clock for the auth lookup, never re-armed for a body.
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  test("public routes read their body under the idle clock, then return to the deadline's", async () => {
    const h = harness();
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };
    const response = await h.app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...BROWSER },
        body: JSON.stringify({ email: "a@example.com", password: WRONG }),
      },
      env,
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      BODY_IDLE_TIMEOUT_SECONDS,
      REQUEST_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);
  });

  test("reauthenticate follows the cookie session: logout, disable and role change end it", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const reauth = async () =>
      (
        (await (
          await h.app.request("/v1/reauth", { headers: { Cookie: cookie } })
        ).json()) as { ok: boolean }
      ).ok;
    expect(await reauth()).toBe(true);

    const membership = h.identity.memberships[0];
    const session = h.identity.sessions[0];
    if (!membership || !session) throw new Error("bootstrap left no rows");
    h.hooks.beforeReauth = () => {
      membership.role = "member";
    };
    expect(await reauth()).toBe(false);
    membership.role = "owner";
    h.hooks.beforeReauth = () => {
      membership.disabledAt = new Date();
    };
    expect(await reauth()).toBe(false);
    membership.disabledAt = null;
    h.hooks.beforeReauth = () => {
      session.revokedAt = new Date();
    };
    expect(await reauth()).toBe(false);
  });

  test("reauthenticate follows the API key", async () => {
    const h = harness();
    const response = await h.app.request("/v1/reauth", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(await response.json()).toEqual({ ok: true });
  });

  test("AUTH_MODE=none keeps trusting X-Owner-Id and ignores cookies", async () => {
    const h = harness({ authMode: "none" });
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const header = await h.app.request("/v1/whoami", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(await header.json()).toMatchObject({
      owner_id: "local-owner",
      principal: { kind: "api_key", id: "local-owner" },
    });
    expect(
      (await h.app.request("/v1/whoami", { headers: { Cookie: cookie } }))
        .status,
    ).toBe(401);
  });
});

describe("login CSRF", () => {
  test("login needs the custom header, so a cross-site form cannot swap the victim's session", async () => {
    const h = harness();
    await h.bootstrap();
    const body = JSON.stringify({
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    // What a cross-site top-level form can send: text/plain, no custom
    // header, Sec-Fetch-Site cross-site. No cookie may come back.
    const form = await h.app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://evil.example",
      },
      body,
    });
    expect(form.status).toBe(403);
    expect(form.headers.get("Set-Cookie")).toBeNull();
    const noHeader = await h.json("/v1/auth/login", JSON.parse(body));
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.get("Set-Cookie")).toBeNull();
    const withHeaderCrossSite = await h.json(
      "/v1/auth/login",
      JSON.parse(body),
      {
        ...BROWSER,
        "Sec-Fetch-Site": "cross-site",
      },
    );
    expect(withHeaderCrossSite.status).toBe(403);
    // Refused before the credentials are looked at: no session row.
    expect(h.identity.sessions).toHaveLength(0);
    expect((await h.login()).status).toBe(200);
  });

  test("a user keeps at most WEB_SESSIONS_PER_USER live sessions; the oldest goes first", async () => {
    const h = harness();
    await h.bootstrap();
    const cookies: string[] = [];
    for (let i = 0; i < WEB_SESSIONS_PER_USER + 2; i += 1) {
      cookies.push(cookieOf(await h.login()));
    }
    expect(h.identity.sessions).toHaveLength(WEB_SESSIONS_PER_USER);
    const status = async (cookie: string) =>
      (await h.app.request("/v1/whoami", { headers: { Cookie: cookie } }))
        .status;
    expect(await status(cookies[0] ?? "")).toBe(401);
    expect(await status(cookies[1] ?? "")).toBe(401);
    expect(await status(cookies[2] ?? "")).toBe(200);
    expect(await status(cookies.at(-1) ?? "")).toBe(200);
  });
});

describe("CSRF", () => {
  test("a cookie mutation needs the custom header; a bearer mutation does not", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());

    const noHeader = await h.json("/v1/mutate", {}, { Cookie: cookie });
    expect(noHeader.status).toBe(403);
    expect(await errorCode(noHeader)).toBe("FORBIDDEN");

    const withHeader = await h.json(
      "/v1/mutate",
      {},
      { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    );
    expect(withHeader.status).toBe(201);

    const bearer = await h.json(
      "/v1/mutate",
      {},
      { Authorization: `Bearer ${API_KEY}` },
    );
    expect(bearer.status).toBe(201);

    // Reads never need it.
    const read = await h.app.request("/v1/whoami", {
      headers: { Cookie: cookie },
    });
    expect(read.status).toBe(200);
  });

  test("a cross-site or foreign-origin request is refused even with the header", async () => {
    const h = harness();
    await h.bootstrap();
    const cookie = cookieOf(await h.login());
    const base = { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect(
      (
        await h.json(
          "/v1/mutate",
          {},
          {
            ...base,
            Host: "app.example",
            Origin: "https://evil.example",
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.json(
          "/v1/mutate",
          {},
          {
            ...base,
            Host: "app.example",
            Origin: "https://app.example",
          },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await h.json(
          "/v1/mutate",
          {},
          {
            ...base,
            "Sec-Fetch-Site": "cross-site",
          },
        )
      ).status,
    ).toBe(403);
  });

  test("csrfViolation is a no-op for non-user principals", () => {
    const principal = legacyApiKeyPrincipal("o");
    const context = {
      req: { method: "POST", header: () => undefined },
    } as never;
    expect(csrfViolation(context, principal)).toBeNull();
  });
});

test("hashPassword produces argon2id", async () => {
  expect(await hashPassword("x".repeat(12))).toStartWith("$argon2id$");
});
