import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  githubSettingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createGitHubSettingsService,
  type GitHubSettingsStore,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerGitHubSettingsRoutes } from "./github-settings.ts";

const createApiApp = recordRouteErrors("routes/github-settings.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

const KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const keyStore = {
  async find(candidate: Uint8Array) {
    if (!Buffer.from(hashApiKey(KEY.plaintext)).equals(Buffer.from(candidate)))
      return null;
    return {
      id: crypto.randomUUID(),
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: "personal" as const,
      agentId: null,
      createdByUserId: crypto.randomUUID(),
      creatorRole: "owner" as const,
      scopes: ["sessions:read" as const, "sessions:write" as const],
    };
  },
};

// The Postgres store (CAS, receipts) is its own integration test.
function memoryStore() {
  let held = { ceiling: GITHUB_CEILING_NONE, revision: 0 };
  const writes: Array<{ updatedBy: string; ceiling: GitHubCeiling }> = [];
  const store: GitHubSettingsStore = {
    async get() {
      return held;
    },
    async agentsUsing() {
      return { workflows: 0, actions: 2, checks: 0, issues: 0, review: 0 };
    },
    async appPermissions() {
      return {
        author: { permissions: { contents: "write", actions: "write" } },
        reviewer: null,
      };
    },
    async putCeiling(input) {
      if (input.workspaceId !== WORKSPACE) {
        return { outcome: "workspace_not_found" };
      }
      if (input.revision !== held.revision) {
        return { outcome: "revision_conflict" };
      }
      held = { ceiling: input.ceiling, revision: held.revision + 1 };
      writes.push({ updatedBy: input.updatedBy, ceiling: input.ceiling });
      return { outcome: "stored", settings: held };
    },
  };
  return { store, writes, held: () => held };
}

function appWith(options: { authorApp?: boolean; secretsOn?: boolean } = {}) {
  const memory = memoryStore();
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerGitHubSettingsRoutes(
        router,
        createGitHubSettingsService({
          authorization: createAuthorizationPolicy({}),
          store: memory.store,
          oauth: {
            status: async () => ({
              authorApp: options.authorApp ?? false,
              clientId: null,
              clientSecretSet: false,
            }),
            client: async () => null,
            putClientSecret: async () => ({ outcome: "no_author_app" }),
          },
          callbackUrl: null,
          secretsOn: options.secretsOn ?? true,
        }),
      ),
  });
  const call = async (
    method: "GET" | "PUT",
    request: {
      cookie?: string;
      key?: boolean;
      body?: unknown;
      workspaceId?: string;
      path?: string;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${request.workspaceId ?? WORKSPACE}/github-settings${request.path ?? ""}`,
      {
        method,
        headers: {
          ...(request.cookie ? { Cookie: request.cookie } : {}),
          ...(request.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          ...(request.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      },
    );
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { call, memory };
}

const ACTIONS_ON = { ...GITHUB_CEILING_NONE, actions: true };
const code = (json: unknown) => apiErrorResponseSchema.parse(json).error;

describe("the GitHub settings API", () => {
  test("an owner reads the ceiling and raises it at the revision read", async () => {
    const { call, memory } = appWith();
    const owner = cookieFor("owner");
    const read = await call("GET", { cookie: owner });
    expect(read.status).toBe(200);
    expect(githubSettingsResponseSchema.parse(read.json)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
      agents_using: {
        workflows: 0,
        actions: 2,
        checks: 0,
        issues: 0,
        review: 0,
      },
      oauth: { client_id: null, client_secret_set: false, callback_url: null },
      apps: {
        author: { permissions: { contents: "write", actions: "write" } },
        reviewer: null,
      },
    });

    const put = await call("PUT", {
      cookie: owner,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    expect(put.status).toBe(200);
    expect(githubSettingsResponseSchema.parse(put.json)).toMatchObject({
      ceiling: ACTIONS_ON,
      revision: 1,
    });
    expect(memory.writes).toEqual([
      { updatedBy: expect.any(String), ceiling: ACTIONS_ON },
    ]);
    expect((await call("GET", { cookie: owner })).json.revision).toBe(1);
  });

  test("a stale revision is 409 REVISION_CONFLICT and changes nothing", async () => {
    const { call, memory } = appWith();
    const owner = cookieFor("owner");
    await call("PUT", {
      cookie: owner,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    const stale = await call("PUT", {
      cookie: cookieFor("admin"),
      body: { ceiling: GITHUB_CEILING_NONE, revision: 0 },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json).code).toBe("REVISION_CONFLICT");
    expect(memory.held()).toEqual({ ceiling: ACTIONS_ON, revision: 1 });
  });

  test("a member reads the ceiling but may not change it", async () => {
    const { call, memory } = appWith();
    const member = cookieFor("member");
    expect((await call("GET", { cookie: member })).status).toBe(200);
    const put = await call("PUT", {
      cookie: member,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    expect(put.status).toBe(403);
    expect(code(put.json).code).toBe("FORBIDDEN");
    expect(memory.writes).toEqual([]);
  });

  test("an API key may neither read nor change the ceiling", async () => {
    const { call, memory } = appWith();
    const read = await call("GET", { key: true });
    expect(read.status).toBe(403);
    expect(code(read.json).code).toBe("FORBIDDEN");
    const put = await call("PUT", {
      key: true,
      body: { ceiling: ACTIONS_ON, revision: 0 },
    });
    expect(put.status).toBe(403);
    expect(code(put.json).code).toBe("FORBIDDEN");
    expect(memory.writes).toEqual([]);
  });

  test("another workspace's path is not found; a malformed body is refused", async () => {
    const { call, memory } = appWith();
    const stranger = cookieFor("owner", OTHER_WORKSPACE);
    expect((await call("GET", { cookie: stranger })).status).toBe(404);
    expect(
      (
        await call("PUT", {
          cookie: stranger,
          body: { ceiling: ACTIONS_ON, revision: 0 },
        })
      ).status,
    ).toBe(404);
    const owner = cookieFor("owner");
    for (const body of [
      { ceiling: ACTIONS_ON },
      { ceiling: { actions: true }, revision: 0 },
      { ceiling: ACTIONS_ON, revision: -1 },
      { ceiling: ACTIONS_ON, revision: 0, extra: 1 },
    ]) {
      expect((await call("PUT", { cookie: owner, body })).status).toBe(400);
    }
    const huge = await call("PUT", {
      cookie: owner,
      body: {
        ceiling: ACTIONS_ON,
        revision: 0,
        pad: "a".repeat(REQUEST_BODY_MAX_BYTES),
      },
    });
    expect(huge.status).toBe(413);
    expect(memory.writes).toEqual([]);
  });

  test("unauthenticated calls are 401", async () => {
    const { call } = appWith();
    for (const method of ["GET", "PUT"] as const) {
      expect((await call(method)).status).toBe(401);
    }
  });
});

// Each refusal here comes before a client secret would be read, so no
// request carries one.
describe("PUT the GitHub OAuth client secret", () => {
  const path = "/oauth-client-secret";

  test("without an author App it is 409 GITHUB_LINK_NOT_CONFIGURED", async () => {
    const { call } = appWith();
    const response = await call("PUT", {
      cookie: cookieFor("owner"),
      path,
      body: {},
    });
    expect(response.status).toBe(409);
    expect(code(response.json)).toMatchObject({
      code: "GITHUB_LINK_NOT_CONFIGURED",
      details: { reason_code: "no_author_app" },
    });
  });

  test("a member is 403, an API key 403, another workspace 404, no login 401", async () => {
    const { call } = appWith({ authorApp: true });
    expect(
      (await call("PUT", { cookie: cookieFor("member"), path, body: {} }))
        .status,
    ).toBe(403);
    expect((await call("PUT", { key: true, path, body: {} })).status).toBe(403);
    expect(
      (
        await call("PUT", {
          cookie: cookieFor("owner", OTHER_WORKSPACE),
          path,
          body: {},
        })
      ).status,
    ).toBe(404);
    expect((await call("PUT", { path, body: {} })).status).toBe(401);
  });

  test("a body without a secret is 400 and an oversized one 413", async () => {
    const { call } = appWith({ authorApp: true });
    const owner = cookieFor("owner");
    expect((await call("PUT", { cookie: owner, path, body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await call("PUT", {
          cookie: owner,
          path,
          body: { pad: "a".repeat(REQUEST_BODY_MAX_BYTES) },
        })
      ).status,
    ).toBe(413);
  });

  test("with the secret store off it is 503", async () => {
    const { call } = appWith({ authorApp: true, secretsOn: false });
    const response = await call("PUT", {
      cookie: cookieFor("owner"),
      path,
      body: {},
    });
    expect(response.status).toBe(503);
    expect(code(response.json).code).toBe("BACKEND_UNAVAILABLE");
  });
});
