import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  agentGitHubActivityResponseSchema,
  agentGitHubResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  GITHUB_CEILING_NONE,
  putAgentGitHubEnabledResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AgentGitHubStore,
  createAgentGitHubService,
  createAuthorizationPolicy,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
  type SessionCatalog,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerAgentGitHubRoutes } from "./agent-github.ts";

const createApiApp = recordRouteErrors("routes/agent-github.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const MISSING = "019a0000-0000-7000-8000-0000000000c9";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId: WORKSPACE,
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

const catalog = {
  profiles: {},
  repositories: {
    "sample-app": {
      url: "https://github.com/acme/sample-app",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
} as unknown as SessionCatalog;

// The Postgres store (receipts, the visibility filter) is its own
// integration test (agent-github.integration.test.ts).
function appWith() {
  let enabled = true;
  const writes: boolean[] = [];
  const store: AgentGitHubStore = {
    async enabled(_workspaceId, agentId) {
      return agentId === AGENT ? enabled : null;
    },
    async setEnabled(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      const changed = enabled !== input.enabled;
      enabled = input.enabled;
      if (changed) writes.push(input.enabled);
      return {
        outcome: "saved",
        receiptId: changed ? crypto.randomUUID() : null,
      };
    },
    async activity() {
      return [];
    },
  };
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerAgentGitHubRoutes(
        router,
        createAgentGitHubService({
          authorization: createAuthorizationPolicy({}),
          agents: {
            async get(_workspaceId, agentId) {
              return agentId === AGENT
                ? ({ active_release: null } as unknown as AgentDetail)
                : null;
            },
          },
          store,
          catalog,
          githubSettings: {
            async get() {
              return { ceiling: GITHUB_CEILING_NONE, revision: 0 };
            },
            async appPermissions() {
              return { author: null, reviewer: null };
            },
          },
        }),
      ),
  });
  const call = async (
    method: "GET" | "PUT",
    path: string,
    request: { cookie?: string; key?: boolean; body?: unknown } = {},
  ) => {
    const response = await app.request(path, {
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
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { call, writes };
}

const code = (json: unknown) => apiErrorResponseSchema.parse(json).error.code;
const github = (id = AGENT) => `/v1/agents/${id}/github`;

describe("the agent GitHub API", () => {
  test("an admin reads the tab and its activity; an agent without a release has nothing to save", async () => {
    const { call } = appWith();
    const admin = cookieFor("admin");
    const read = await call("GET", github(), { cookie: admin });
    expect(read.status).toBe(200);
    expect(agentGitHubResponseSchema.parse(read.json)).toMatchObject({
      enabled: true,
      github: null,
      legacy_defaults: null,
      unsavable: "no_active_release",
    });
    const activity = await call("GET", `${github()}/activity`, {
      cookie: admin,
    });
    expect(activity.status).toBe(200);
    expect(agentGitHubActivityResponseSchema.parse(activity.json)).toEqual({
      items: [],
    });
  });

  test("the switch turns off once and reports no receipt the second time", async () => {
    const { call, writes } = appWith();
    const admin = cookieFor("admin");
    const off = await call("PUT", `${github()}/enabled`, {
      cookie: admin,
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect(putAgentGitHubEnabledResponseSchema.parse(off.json)).toMatchObject({
      enabled: false,
      receipt_id: expect.any(String),
    });
    const again = await call("PUT", `${github()}/enabled`, {
      cookie: admin,
      body: { enabled: false },
    });
    expect(again.json.receipt_id).toBeNull();
    expect(writes).toEqual([false]);
    expect((await call("GET", github(), { cookie: admin })).json.enabled).toBe(
      false,
    );
  });

  test("a member who manages no agent is refused; an API key may not turn the switch", async () => {
    const { call, writes } = appWith();
    const member = cookieFor("member");
    for (const path of [github(), `${github()}/activity`]) {
      const read = await call("GET", path, { cookie: member });
      expect(read.status).toBe(403);
      expect(code(read.json)).toBe("FORBIDDEN");
    }
    expect(
      (
        await call("PUT", `${github()}/enabled`, {
          cookie: member,
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    const byKey = await call("PUT", `${github()}/enabled`, {
      key: true,
      body: { enabled: false },
    });
    expect(byKey.status).toBe(403);
    expect(code(byKey.json)).toBe("FORBIDDEN");
    expect(writes).toEqual([]);
  });

  test("an unknown agent is not found; a malformed body is refused", async () => {
    const { call, writes } = appWith();
    const owner = cookieFor("owner");
    expect((await call("GET", github(MISSING), { cookie: owner })).status).toBe(
      404,
    );
    expect(
      (await call("GET", `${github(MISSING)}/activity`, { cookie: owner }))
        .status,
    ).toBe(404);
    expect(
      (
        await call("PUT", `${github(MISSING)}/enabled`, {
          cookie: owner,
          body: { enabled: false },
        })
      ).status,
    ).toBe(404);
    for (const body of [{}, { enabled: "no" }, { enabled: true, extra: 1 }]) {
      expect(
        (await call("PUT", `${github()}/enabled`, { cookie: owner, body }))
          .status,
      ).toBe(400);
    }
    const huge = await call("PUT", `${github()}/enabled`, {
      cookie: owner,
      body: { enabled: true, pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(huge.status).toBe(413);
    expect(writes).toEqual([]);
  });
});
