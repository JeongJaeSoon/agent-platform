import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  deleteGitHubAppResponseSchema,
  type GitHubAppRole,
  getGitHubAppResponseSchema,
  putGitHubAppResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createGitHubAppService,
  type GitHubAppCredential,
  type GitHubAppRecord,
  type GitHubAppStore,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { createGitHubAppDirectory } from "../forge-github.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerGitHubAppRoutes } from "./github-app.ts";

const createApiApp = recordRouteErrors("routes/github-app.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const APP_ID = 4242;

const rsaPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
const keys = rsaPair();
const privateKey = keys.privateKey;
const strangerKey = rsaPair().privateKey;

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

// The Postgres store's behaviour (audit, receipts, sealing) is its own
// integration test; this one only remembers.
function memoryStore() {
  type Held = { record: GitHubAppRecord; key: string };
  const held = new Map<GitHubAppRole, Held>();
  const receipts: Array<{ operation: string; app_id: number }> = [];
  const permissionReads: Array<{ id: string; permissions: unknown }> = [];
  const mine = (workspaceId: string | undefined, role: GitHubAppRole) => {
    const row = held.get(role);
    return row !== undefined &&
      (workspaceId === undefined || row.record.workspaceId === workspaceId)
      ? row
      : null;
  };
  const store: GitHubAppStore = {
    async find(workspaceId, role) {
      return mine(workspaceId, role)?.record ?? null;
    },
    async put(workspaceId, role, app, key, audit) {
      const at = new Date();
      const by = audit.principal.actor?.userId ?? "";
      const before = held.get(role);
      const row: Held = {
        key,
        record: {
          ...app,
          id: before?.record.id ?? crypto.randomUUID(),
          workspaceId,
          createdAt: before?.record.createdAt ?? at,
          updatedAt: at,
          permissionsCheckedAt: at,
          privateKey: {
            updatedAt: at,
            updatedBy: { userId: by, displayName: "owner" },
          },
        },
      };
      held.set(role, row);
      receipts.push({ operation: "set_github_app", app_id: app.appId });
      return { outcome: "stored", app: row.record };
    },
    async delete(workspaceId, role) {
      const row = mine(workspaceId, role);
      if (row === null) return { outcome: "not_found" };
      held.delete(role);
      receipts.push({
        operation: "delete_github_app",
        app_id: row.record.appId,
      });
      return { outcome: "deleted", appId: row.record.appId };
    },
    async recordPermissions(id, permissions) {
      permissionReads.push({ id, permissions });
      for (const row of held.values()) {
        if (row.record.id === id) {
          row.record = {
            ...row.record,
            permissions,
            permissionsCheckedAt: new Date(),
          };
        }
      }
    },
    async credentials(
      role: GitHubAppRole,
      workspaceId?: string,
    ): Promise<GitHubAppCredential[]> {
      const row = mine(workspaceId, role);
      return row === null
        ? []
        : [
            {
              id: row.record.id,
              workspaceId: row.record.workspaceId,
              appId: row.record.appId,
              apiBase: row.record.apiBase,
              privateKey: row.key,
              updatedAt: row.record.updatedAt,
            },
          ];
    },
  };
  return {
    store,
    receipts,
    permissionReads,
    held: () => held.get("author") ?? null,
    reviewer: () => held.get("reviewer") ?? null,
  };
}

let github: FakeGitHub;
const logs = new MemoryLogSink();
const responses: string[] = [];
const memory = memoryStore();
let changes = 0;

function appWith(options: { enabled?: boolean; apiBase?: string } = {}) {
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerRoutes: (router) =>
      registerGitHubAppRoutes(
        router,
        createGitHubAppService({
          authorization: createAuthorizationPolicy({}),
          store: options.enabled === false ? null : memory.store,
          directory: createGitHubAppDirectory({ retryAfterBaseMs: 1 }),
          apiBase: options.apiBase ?? github.origin,
          repositories: () => [
            { id: "app", url: "https://github.com/acme/app.git" },
            { id: "absent", url: "https://github.com/acme/absent.git" },
          ],
          changed: async () => {
            changes += 1;
          },
        }),
      ),
  });
  return async (
    method: "GET" | "PUT" | "DELETE",
    request: {
      cookie?: string;
      key?: boolean;
      csrf?: boolean;
      body?: string;
      workspaceId?: string;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${request.workspaceId ?? WORKSPACE}/github-app`,
      {
        method,
        headers: {
          ...(request.cookie ? { Cookie: request.cookie } : {}),
          ...(request.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
          ...(request.csrf === false
            ? {}
            : { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }),
          ...(request.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
      },
    );
    const text = await response.text();
    responses.push(text);
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

let call: ReturnType<typeof appWith>;
beforeAll(async () => {
  github = await startFakeGitHub({
    appId: APP_ID,
    publicKey: keys.publicKey,
    installationId: 77,
    slug: "werft-test",
  });
  await github.createRepository("acme", "app", { "README.md": "hi\n" });
  call = appWith();
});
afterAll(async () => {
  await github.stop();
});

const body = (fields: Record<string, unknown>) => JSON.stringify(fields);
const code = (json: unknown) => apiErrorResponseSchema.parse(json).error;

describe("the GitHub App API", () => {
  test("an owner registers the App, sees where it is installed, replaces and removes it", async () => {
    const owner = cookieFor("owner");
    const empty = await call("GET", { cookie: owner });
    expect(getGitHubAppResponseSchema.parse(empty.json)).toEqual({
      github_app: null,
      check: null,
      installations: [],
      repositories: [
        {
          id: "app",
          url: "https://github.com/acme/app.git",
          installation_id: null,
        },
        {
          id: "absent",
          url: "https://github.com/acme/absent.git",
          installation_id: null,
        },
      ],
    });

    const set = await call("PUT", {
      cookie: owner,
      // Windows line ends and a trailing newline, as a pasted file may have.
      body: body({
        app_id: APP_ID,
        private_key: `${privateKey.replace(/\n/g, "\r\n")}\r\n`,
      }),
    });
    expect(set.status).toBe(200);
    expect(putGitHubAppResponseSchema.parse(set.json).github_app).toMatchObject(
      {
        app_id: APP_ID,
        slug: "werft-test",
        name: "Fake werft-test",
        html_url: `${github.origin}/apps/werft-test`,
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
        permissions_checked_at: expect.any(String),
        warnings: [],
      },
    );
    expect(memory.held()?.key).toBe(privateKey.trim());
    expect(changes).toBe(1);

    const read = await call("GET", { cookie: owner });
    expect(getGitHubAppResponseSchema.parse(read.json)).toMatchObject({
      github_app: { app_id: APP_ID },
      check: { state: "ok" },
      installations: [
        { id: 77, account: "acme", repository_selection: "selected" },
      ],
      repositories: [
        { id: "app", installation_id: 77 },
        { id: "absent", installation_id: null },
      ],
    });

    const replaced = await call("PUT", {
      cookie: cookieFor("admin"),
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    expect(replaced.status).toBe(200);

    const deleted = await call("DELETE", { cookie: owner });
    expect(deleted.status).toBe(200);
    deleteGitHubAppResponseSchema.parse(deleted.json);
    expect(memory.receipts.map(({ operation }) => operation)).toEqual([
      "set_github_app",
      "set_github_app",
      "delete_github_app",
    ]);
    expect((await call("GET", { cookie: owner })).json.github_app).toBeNull();
    expect((await call("DELETE", { cookie: owner })).status).toBe(404);
  });

  test("the routes are the author App's: a reviewer row is never read, replaced or deleted", async () => {
    const owner = cookieFor("owner");
    await memory.store.put(
      WORKSPACE,
      "reviewer",
      {
        appId: APP_ID + 1,
        slug: "reviewer",
        name: "Reviewer",
        htmlUrl: "https://github.com/apps/reviewer",
        clientId: null,
        permissions: {},
        apiBase: github.origin,
      },
      strangerKey,
      { principal: { ownerId: WORKSPACE }, receiptId: "r", roles: [] },
    );
    const reviewer = memory.reviewer();
    expect((await call("GET", { cookie: owner })).json.github_app).toBeNull();
    expect((await call("DELETE", { cookie: owner })).status).toBe(404);
    const set = await call("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: keys.privateKey }),
    });
    expect(set.json.github_app.app_id).toBe(APP_ID);
    expect((await call("DELETE", { cookie: owner })).status).toBe(200);
    expect(memory.reviewer()).toBe(reviewer);
    expect(memory.reviewer()?.key).toBe(strangerKey);
    await memory.store.delete(WORKSPACE, "reviewer", {
      principal: { ownerId: WORKSPACE },
      receiptId: "r",
      roles: [],
    });
  });

  test("a read keeps the App's permissions as GitHub reports them now, and warns of any wider than the guidance", async () => {
    const owner = cookieFor("owner");
    await call("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    const id = memory.held()?.record.id;
    github.setPermissions({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      administration: "write",
    });
    try {
      const read = await call("GET", { cookie: owner });
      expect(
        getGitHubAppResponseSchema.parse(read.json).github_app,
      ).toMatchObject({
        permissions: { administration: "write", contents: "write" },
        permissions_checked_at: expect.any(String),
        warnings: [
          { permission: "administration", level: "write", guided: null },
        ],
      });
      expect(memory.permissionReads.at(-1)).toEqual({
        id: id as string,
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
          administration: "write",
        },
      });
      expect(memory.held()?.record.permissions).toMatchObject({
        administration: "write",
      });
    } finally {
      github.setPermissions(undefined);
      await call("DELETE", { cookie: owner });
    }
  });

  test("a key that is not RSA, or that GitHub does not take for the id, is refused and nothing is stored", async () => {
    const owner = cookieFor("owner");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    for (const [privateKeyText, appId, reason] of [
      ["not a key", APP_ID, "invalid_private_key"],
      [ec, APP_ID, "invalid_private_key"],
      [strangerKey, APP_ID, "github_app_rejected"],
      [privateKey, APP_ID + 1, "github_app_rejected"],
    ] as const) {
      const refused = await call("PUT", {
        cookie: owner,
        body: body({ app_id: appId, private_key: privateKeyText }),
      });
      expect(refused.status).toBe(400);
      expect(code(refused.json)).toMatchObject({
        code: "BAD_REQUEST",
        details: { reason_code: reason },
      });
    }
    expect(memory.held()).toBeNull();
  });

  test("GitHub not answering is 503 on register and a failed check on read", async () => {
    const owner = cookieFor("owner");
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const down = appWith({ apiBase: `http://127.0.0.1:${closed.port}` });
    closed.stop(true);
    const refused = await down("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    expect(refused.status).toBe(503);
    expect(code(refused.json).details).toEqual({
      reason_code: "github_unreachable",
    });
    expect(memory.held()).toBeNull();

    await call("PUT", {
      cookie: owner,
      body: body({ app_id: APP_ID, private_key: privateKey }),
    });
    await github.stop();
    const read = await call("GET", { cookie: owner });
    expect(read.json).toMatchObject({
      github_app: { app_id: APP_ID },
      check: { state: "failed", reason_code: "github_unreachable" },
      installations: [],
    });
    github = await startFakeGitHub({
      appId: APP_ID,
      publicKey: keys.publicKey,
      port: Number(new URL(github.origin).port),
    });
    await call("DELETE", { cookie: owner });
  });

  test("a member is refused on every method", async () => {
    const member = cookieFor("member");
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        cookie: member,
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(403);
    }
    expect(memory.held()).toBeNull();
  });

  test("an API key is refused", async () => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        key: true,
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(memory.held()).toBeNull();
  });

  test("another workspace's path is not found", async () => {
    const stranger = cookieFor("owner", OTHER_WORKSPACE);
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        cookie: stranger,
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  test("a malformed or oversized body is refused", async () => {
    const owner = cookieFor("owner");
    for (const text of [
      body({ app_id: "4242", private_key: privateKey }),
      body({ app_id: APP_ID }),
      body({ app_id: APP_ID, private_key: privateKey, extra: 1 }),
      '{"app_id": 1',
    ]) {
      expect((await call("PUT", { cookie: owner, body: text })).status).toBe(
        400,
      );
    }
    const huge = await call("PUT", {
      cookie: owner,
      body: body({
        app_id: APP_ID,
        private_key: "a".repeat(REQUEST_BODY_MAX_BYTES),
      }),
    });
    expect(huge.status).toBe(413);
  });

  test("a cookie write without the CSRF header is refused", async () => {
    const response = await call("DELETE", {
      cookie: cookieFor("owner"),
      csrf: false,
    });
    expect(response.status).toBe(403);
  });

  test("without a master key every method answers 503", async () => {
    const off = appWith({ enabled: false });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await off(method, {
        cookie: cookieFor("owner"),
        ...(method === "PUT"
          ? { body: body({ app_id: APP_ID, private_key: privateKey }) }
          : {}),
      });
      expect(response.status).toBe(503);
      expect(code(response.json).message).toContain("PLATFORM_SECRET_KEY");
    }
  });

  test("unauthenticated calls are 401", async () => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      expect((await call(method)).status).toBe(401);
    }
  });
});

afterAll(() => {
  const seen = [...responses, ...logs.records.map((r) => JSON.stringify(r))];
  const body = privateKey.split("\n")[1] ?? "";
  expect(body.length).toBeGreaterThan(20);
  for (const text of seen) expect(text).not.toContain(body);
});
