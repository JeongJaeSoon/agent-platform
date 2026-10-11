import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  GOOGLE_LOGIN_COOKIE_NAME,
  loginResponseSchema,
  startGoogleLoginResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@agent-platform/contracts";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import type {
  ExternalSignInInput,
  ExternalSignInResult,
  IdentityStore,
} from "@agent-platform/platform";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@agent-platform/testkit/mock-oidc";
import { createBootstrapGate } from "./auth.ts";
import {
  createGoogleLogin,
  domainAdmission,
  GOOGLE_ISSUER,
  type GoogleLogin,
  type GoogleLoginConfig,
  GoogleLoginInvalidError,
  googleLoginConfigFromEnv,
} from "./google-login.ts";
import { recordRouteErrors } from "./route-error-coverage.ts";
import { registerPublicAuthRoutes } from "./routes/auth.ts";

const createApiApp = recordRouteErrors("google-login.test.ts");

const CLIENT_ID = "client-id.apps.example";
const CLIENT_SECRET = "mock-client-secret";
const REDIRECT_URI = "https://werft.example/auth/google/callback";

let idp: MockOidcServer;
beforeAll(async () => {
  idp = await startMockOidcServer({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
});
afterAll(() => idp.stop());

function configFor(overrides: Partial<GoogleLoginConfig> = {}) {
  return {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    issuer: idp.issuer,
    allowedDomains: [],
    jit: false,
    ...overrides,
  } satisfies GoogleLoginConfig;
}

const alice: MockOidcClaims = {
  sub: "1001",
  email: "Alice@Example.com",
  hd: "example.com",
  name: "Alice",
};

async function flow(google: GoogleLogin, claims: MockOidcClaims) {
  const started = await google.start();
  const back = await idp.authorize(started.authorizationUrl, claims);
  return { cookieValue: started.cookieValue, ...back };
}

describe("googleLoginConfigFromEnv", () => {
  test("unset is off, not a problem", () => {
    expect(googleLoginConfigFromEnv({})).toEqual({
      config: null,
      problems: [],
    });
  });

  test("a complete configuration defaults to Google with no domain list", () => {
    const { config, problems } = googleLoginConfigFromEnv({
      GOOGLE_OIDC_CLIENT_ID: CLIENT_ID,
      GOOGLE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_OIDC_REDIRECT_URI: REDIRECT_URI,
      GOOGLE_OIDC_ALLOWED_DOMAINS: " Example.com, ,corp.example ",
    });
    expect(problems).toEqual([]);
    expect(config).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      issuer: GOOGLE_ISSUER,
      allowedDomains: ["example.com", "corp.example"],
      jit: false,
    });
  });

  test("half a configuration, a bad JIT value and JIT without domains refuse to start", () => {
    expect(
      googleLoginConfigFromEnv({ GOOGLE_OIDC_CLIENT_ID: CLIENT_ID }).problems,
    ).toEqual([
      "GOOGLE_OIDC_CLIENT_SECRET is required",
      "GOOGLE_OIDC_REDIRECT_URI is required",
    ]);
    expect(
      googleLoginConfigFromEnv({ GOOGLE_OIDC_JIT: "member" }).problems,
    ).toEqual([
      "GOOGLE_OIDC_JIT set without GOOGLE_OIDC_CLIENT_ID, GOOGLE_OIDC_CLIENT_SECRET and GOOGLE_OIDC_REDIRECT_URI",
    ]);
    const complete = {
      GOOGLE_OIDC_CLIENT_ID: CLIENT_ID,
      GOOGLE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_OIDC_REDIRECT_URI: REDIRECT_URI,
    };
    expect(
      googleLoginConfigFromEnv({ ...complete, GOOGLE_OIDC_JIT: "owner" })
        .problems,
    ).toEqual(["GOOGLE_OIDC_JIT must be off or member"]);
    expect(
      googleLoginConfigFromEnv({ ...complete, GOOGLE_OIDC_JIT: "member" })
        .problems,
    ).toEqual(["GOOGLE_OIDC_JIT=member requires GOOGLE_OIDC_ALLOWED_DOMAINS"]);
    expect(
      googleLoginConfigFromEnv({
        ...complete,
        GOOGLE_OIDC_REDIRECT_URI: "/relative",
      }).problems,
    ).toEqual(["GOOGLE_OIDC_REDIRECT_URI must be an absolute URL"]);
  });
});

describe("Google OIDC client", () => {
  test("start asks for a code with PKCE S256, state and nonce", async () => {
    const google = createGoogleLogin(
      configFor({ allowedDomains: ["example.com"] }),
    );
    const { authorizationUrl, cookieValue } = await google.start();
    const query = new URL(authorizationUrl).searchParams;
    const [state, nonce, verifier] = cookieValue.split(".");
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(CLIENT_ID);
    expect(query.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(query.get("scope")).toBe("openid email profile");
    expect(query.get("state")).toBe(state ?? "");
    expect(query.get("nonce")).toBe(nonce ?? "");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).not.toBe(verifier ?? "");
    expect(query.get("hd")).toBe("example.com");
  });

  test("finish returns the verified identity with a normalized email", async () => {
    const google = createGoogleLogin(configFor());
    const identity = await google.finish(await flow(google, alice));
    expect(identity).toEqual({
      issuer: idp.issuer,
      subject: "1001",
      email: "alice@example.com",
      hostedDomain: "example.com",
      name: "Alice",
    });
  });

  const refusals: Array<[string, MockOidcClaims]> = [
    ["an unverified email", { ...alice, email_verified: false }],
    ["another audience", { ...alice, aud: "someone-else" }],
    ["another issuer", { ...alice, iss: "https://evil.example" }],
    ["an expired token", { ...alice, exp: Math.floor(Date.now() / 1000) - 5 }],
    ["no exp at all", { ...alice, exp: null }],
    ["another nonce", { ...alice, nonce: "replayed" }],
    ["another authorized party", { ...alice, azp: "someone-else" }],
    ["no subject", { ...alice, sub: "" }],
  ];
  for (const [what, claims] of refusals) {
    test(`finish refuses ${what}`, async () => {
      const google = createGoogleLogin(configFor());
      await expect(google.finish(await flow(google, claims))).rejects.toThrow(
        GoogleLoginInvalidError,
      );
    });
  }

  test("finish refuses a state that is not this browser's, a stale flow and a spent code", async () => {
    let clock = Date.now();
    const google = createGoogleLogin(configFor(), () => clock);
    const first = await flow(google, alice);
    await expect(
      google.finish({ ...first, cookieValue: undefined }),
    ).rejects.toThrow("state does not match");
    const other = await flow(google, alice);
    await expect(
      google.finish({ ...first, cookieValue: other.cookieValue }),
    ).rejects.toThrow("state does not match");

    const stale = await flow(google, alice);
    clock += 10 * 60 * 1000 + 1;
    await expect(google.finish(stale)).rejects.toThrow("expired");
    clock = Date.now();

    const once = await flow(google, alice);
    await google.finish(once);
    await expect(google.finish(once)).rejects.toThrow("refused the code");
  });

  test("domainAdmission needs the hosted domain and the address to match the list", () => {
    const restricted = configFor({ allowedDomains: ["example.com"] });
    const identity = {
      issuer: GOOGLE_ISSUER,
      subject: "1",
      email: "a@example.com",
      hostedDomain: "example.com",
      name: null,
    };
    expect(domainAdmission(restricted, identity)).toEqual({
      jitRole: null,
      ownsEmail: true,
    });
    expect(domainAdmission({ ...restricted, jit: true }, identity)).toEqual({
      jitRole: "member",
      ownsEmail: true,
    });
    expect(
      domainAdmission(restricted, { ...identity, hostedDomain: null }),
    ).toBeNull();
    expect(
      domainAdmission(restricted, {
        ...identity,
        hostedDomain: "other.example",
      }),
    ).toBeNull();
    expect(
      domainAdmission(restricted, { ...identity, email: "a@other.example" }),
    ).toBeNull();
  });

  test("with no domain list an invite is open only to an address Google vouches for", () => {
    const open = configFor({});
    const identity = {
      issuer: GOOGLE_ISSUER,
      subject: "1",
      email: "a@example.com",
      hostedDomain: "example.com",
      name: null,
    };
    expect(domainAdmission(open, identity)).toEqual({
      jitRole: null,
      ownsEmail: true,
    });
    expect(
      domainAdmission(open, {
        ...identity,
        email: "a@gmail.com",
        hostedDomain: null,
      }),
    ).toEqual({ jitRole: null, ownsEmail: true });
    expect(domainAdmission(open, { ...identity, hostedDomain: null })).toEqual({
      jitRole: null,
      ownsEmail: false,
    });
    expect(
      domainAdmission(open, { ...identity, hostedDomain: "other.example" }),
    ).toEqual({ jitRole: null, ownsEmail: false });
  });
});

describe("Google sign-in routes", () => {
  function harness(
    options: {
      google?: GoogleLogin | null;
      result?: ExternalSignInResult;
    } = {},
  ) {
    const calls: ExternalSignInInput[] = [];
    const identity = {
      async signInWithExternalIdentity(input: ExternalSignInInput) {
        calls.push(input);
        return (
          options.result ?? {
            outcome: "signed_in",
            via: "jit",
            userId: "00000000-0000-4000-8000-000000000001",
            workspaceId: "00000000-0000-4000-8000-000000000002",
            role: "member",
            expiresAt: new Date(Date.now() + 60_000),
          }
        );
      },
    } as unknown as IdentityStore;
    const google =
      options.google === undefined
        ? createGoogleLogin(configFor())
        : options.google;
    const app = createApiApp({
      authMode: "api-key",
      logger: new StructuredLogger({ sinks: [new MemoryLogSink()] }),
      identity,
      keyStore: { find: async () => null },
      registerPublicRoutes: (router) =>
        registerPublicAuthRoutes(router, {
          identity,
          bootstrap: createBootstrapGate("x".repeat(32)),
          ...(google ? { google } : {}),
        }),
    });
    const post = (
      path: string,
      init: { body?: unknown; cookie?: string } = {},
    ) =>
      app.request(path, {
        method: "POST",
        headers: {
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          "Content-Type": "application/json",
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    const signIn = async (claims: MockOidcClaims) => {
      const started = await post("/v1/auth/google/start");
      expect(started.status).toBe(200);
      const setCookie = started.headers.get("Set-Cookie") ?? "";
      const flowCookie = setCookie.split(";")[0] ?? "";
      const { authorization_url } = startGoogleLoginResponseSchema.parse(
        await started.json(),
      );
      const back = await idp.authorize(authorization_url, claims);
      return post("/v1/auth/google/callback", {
        body: back,
        cookie: flowCookie,
      });
    };
    return { app, post, signIn, calls };
  }

  test("start sets a flow cookie scoped like the session cookie", async () => {
    const { post } = harness();
    const response = await post("/v1/auth/google/start");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toStartWith(`${GOOGLE_LOGIN_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
  });

  test("a sign-in sets the session cookie and answers the login body", async () => {
    const { signIn, calls } = harness();
    const response = await signIn(alice);
    expect(response.status).toBe(200);
    const body = loginResponseSchema.parse(await response.json());
    expect(body.role).toBe("member");
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((c) => c.startsWith(`${WEB_SESSION_COOKIE_NAME}=`)),
    ).toBe(true);
    expect(
      cookies.some((c) => c.startsWith(`${GOOGLE_LOGIN_COOKIE_NAME}=;`)),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "google",
      issuer: idp.issuer,
      subject: "1001",
      email: "alice@example.com",
      displayName: "Alice",
      jitRole: null,
    });
  });

  test("JIT passes the member role down; a nameless account is named by its address", async () => {
    const { signIn, calls } = harness({
      google: createGoogleLogin(
        configFor({ allowedDomains: ["example.com"], jit: true }),
      ),
    });
    expect(
      (
        await signIn({
          sub: "1001",
          email: "Alice@Example.com",
          hd: "example.com",
        })
      ).status,
    ).toBe(200);
    expect(calls[0]).toMatchObject({ jitRole: "member", displayName: "alice" });
  });

  test("an address that has an account answers 409 LOGIN_LINK_REQUIRED", async () => {
    const { signIn } = harness({ result: { outcome: "link_required" } });
    const response = await signIn(alice);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("LOGIN_LINK_REQUIRED");
  });

  test("a refusal by the rules and a refusal of the token read the same", async () => {
    const { signIn } = harness({ result: { outcome: "rejected" } });
    const byRules = await signIn(alice);
    const byToken = await signIn({ ...alice, email_verified: false });
    expect(byRules.status).toBe(401);
    expect(byToken.status).toBe(401);
    const strip = async (response: Response) => {
      const { error } = await response.json();
      return { ...error, request_id: undefined };
    };
    expect(await strip(byRules)).toEqual(await strip(byToken));
  });

  test("a domain outside the list answers 403 before any rule runs", async () => {
    const { signIn, calls } = harness({
      google: createGoogleLogin(configFor({ allowedDomains: ["example.com"] })),
    });
    const response = await signIn({ ...alice, hd: "other.example" });
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("both routes refuse a request without the CSRF header", async () => {
    const { app } = harness();
    for (const path of ["/v1/auth/google/start", "/v1/auth/google/callback"]) {
      const response = await app.request(path, { method: "POST" });
      expect(response.status).toBe(403);
    }
  });

  test("a malformed callback is 400 and an oversized one 413", async () => {
    const { post } = harness();
    const malformed = await post("/v1/auth/google/callback", {
      body: { code: 1 },
    });
    expect(malformed.status).toBe(400);
    const oversized = await post("/v1/auth/google/callback", {
      body: { code: "x".repeat(65 * 1024), state: "s" },
    });
    expect(oversized.status).toBe(413);
  });

  test("both routes answer 404 when Google sign-in is not configured", async () => {
    const { post } = harness({ google: null });
    expect((await post("/v1/auth/google/start")).status).toBe(404);
    expect(
      (
        await post("/v1/auth/google/callback", {
          body: { code: "c", state: "s" },
        })
      ).status,
    ).toBe(404);
  });

  test("an unreachable provider answers 503 and is retried by the next request", async () => {
    const { post } = harness({
      google: createGoogleLogin(configFor({ issuer: "http://127.0.0.1:9" })),
    });
    const started = await post("/v1/auth/google/start");
    expect(started.status).toBe(503);
    expect((await started.json()).error.retryable).toBe(true);
    const callback = await post("/v1/auth/google/callback", {
      body: { code: "c", state: "s" },
      cookie: `${GOOGLE_LOGIN_COOKIE_NAME}=s.n.v.${Date.now()}`,
    });
    expect(callback.status).toBe(503);
  });
});
