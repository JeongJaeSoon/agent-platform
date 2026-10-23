import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  deleteSlackSecretResponseSchema,
  putSlackSecretResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  slackSecretSummarySchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSlackSecretService,
  type IdentityStore,
  lastFour,
  type MembershipRole,
  type ResolvedWebSession,
  type SecretSlot,
  type SecretStore,
  type SecretSummary,
  secretOwnerRef,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSlackSecretRoutes } from "./slack-secrets.ts";

const createApiApp = recordRouteErrors("routes/slack-secrets.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
// Made per run: a fixed token-shaped string has no place in a file.
const VALUE = `xoxe-1-${randomBytes(24).toString("hex")}`;

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
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

// A service key, and an owner's own personal key: neither sets a secret.
const KEYS = (["service", "personal"] as const).map((kind) => ({
  kind,
  plaintext: `csp_${crypto.randomUUID()}`,
}));
const keyStore = {
  async find(candidate: Uint8Array) {
    const key = KEYS.find(({ plaintext }) =>
      Buffer.from(hashApiKey(plaintext)).equals(Buffer.from(candidate)),
    );
    if (!key) return null;
    return {
      id: crypto.randomUUID(),
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: key.kind,
      createdByUserId: key.kind === "personal" ? crypto.randomUUID() : null,
      creatorRole: key.kind === "personal" ? ("owner" as const) : null,
      scopes: [
        "sessions:read" as const,
        "sessions:write" as const,
        "sessions:control" as const,
      ],
    };
  },
};

// What the store was handed, for the receipts check: purpose and last four.
const values = new Map<string, { value: string; summary: SecretSummary }>();
const receipts: { id: string; purpose: string; last4: string }[] = [];
const slotKey = (slot: SecretSlot) =>
  `${slot.workspaceId}|${secretOwnerRef(slot.owner)}|${slot.purpose}`;
const store: SecretStore = {
  describe: async (slot) => values.get(slotKey(slot))?.summary ?? null,
  get: async (slot) => values.get(slotKey(slot))?.value ?? null,
  put: async (slot, value, options) => {
    const summary: SecretSummary = {
      last4: lastFour(value),
      secretVersion: 1,
      updatedAt: new Date("2026-10-23T00:00:00.000Z"),
      updatedBy: null,
    };
    values.set(slotKey(slot), { value, summary });
    if (options?.audit) {
      receipts.push({
        id: options.audit.receiptId,
        purpose: slot.purpose,
        last4: summary.last4,
      });
    }
    return { outcome: "stored", summary };
  },
  rotate: async () => null,
  delete: async (slot) => {
    const previous = values.get(slotKey(slot));
    if (!previous) return { outcome: "not_found" };
    values.delete(slotKey(slot));
    return { outcome: "deleted", last4: previous.summary.last4 };
  },
};

const logs = new MemoryLogSink();
const responses: string[] = [];

function appWith(secretStore: SecretStore | null) {
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerRoutes: (router) =>
      registerSlackSecretRoutes(
        router,
        createSlackSecretService({
          authorization: createAuthorizationPolicy({}),
          store: secretStore,
        }),
      ),
  });
  return async (
    method: "GET" | "PUT" | "DELETE",
    options: {
      cookie?: string;
      key?: (typeof KEYS)[number];
      csrf?: boolean;
      body?: string;
      workspaceId?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${options.workspaceId ?? WORKSPACE}/slack/config-token`,
      {
        method,
        headers: {
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.key
            ? { Authorization: `Bearer ${options.key.plaintext}` }
            : {}),
          ...(options.csrf === false
            ? {}
            : { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }),
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
      },
    );
    const text = await response.text();
    responses.push(text);
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

const call = appWith(store);
const put = (value: unknown = VALUE) => JSON.stringify({ value });

function code(json: unknown) {
  return apiErrorResponseSchema.parse(json).error;
}

describe("the Slack config token API", () => {
  test("an owner sets it, sees only the last four, replaces and deletes it", async () => {
    const owner = cookieFor("owner");
    const set = await call("PUT", { cookie: owner, body: put() });
    expect(set.status).toBe(200);
    expect(putSlackSecretResponseSchema.parse(set.json)).toMatchObject({
      configured: true,
      last4: VALUE.slice(-4),
    });
    const read = await call("GET", { cookie: owner });
    expect(slackSecretSummarySchema.parse(read.json)).toEqual({
      configured: true,
      last4: VALUE.slice(-4),
      updated_at: "2026-10-23T00:00:00.000Z",
      updated_by: null,
    });
    const next = `${VALUE}-next`;
    expect(
      (await call("PUT", { cookie: cookieFor("admin"), body: put(next) }))
        .status,
    ).toBe(200);
    expect(values.get(`${WORKSPACE}|workspace|slack_config_token`)?.value).toBe(
      next,
    );
    expect(receipts.map(({ purpose, last4 }) => ({ purpose, last4 }))).toEqual([
      { purpose: "slack_config_token", last4: VALUE.slice(-4) },
      { purpose: "slack_config_token", last4: next.slice(-4) },
    ]);
    const deleted = await call("DELETE", { cookie: owner });
    expect(deleted.status).toBe(200);
    deleteSlackSecretResponseSchema.parse(deleted.json);
    expect((await call("GET", { cookie: owner })).json).toMatchObject({
      configured: false,
      last4: null,
    });
    expect((await call("DELETE", { cookie: owner })).status).toBe(404);
  });

  test("a member is refused on every method and the value is not stored", async () => {
    values.clear();
    const member = cookieFor("member");
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", put()],
      ["DELETE", undefined],
    ] as const) {
      const response = await call(method, {
        cookie: member,
        ...(body ? { body } : {}),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(values.size).toBe(0);
  });

  test.each(KEYS)("an API key is refused ($kind)", async (key) => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await call(method, {
        key,
        ...(method === "PUT" ? { body: put() } : {}),
      });
      // Why each is refused (an owner's key on a non-console surface) is
      // slack-secret-service.test.ts's to show; here, that it is.
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(values.size).toBe(0);
  });

  test("a cookie write without the CSRF header, or from another site, is refused", async () => {
    const owner = cookieFor("owner");
    for (const method of ["PUT", "DELETE"] as const) {
      const response = await call(method, {
        cookie: owner,
        csrf: false,
        ...(method === "PUT" ? { body: put() } : {}),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).message).toContain(CSRF_HEADER_NAME);
    }
    const foreign = [
      { "Sec-Fetch-Site": "cross-site" },
      { Origin: "https://attacker.example" },
    ];
    for (const headers of foreign) {
      const response = await call("PUT", {
        cookie: owner,
        headers,
        body: put(),
      });
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(values.size).toBe(0);
  });

  test("another workspace's path is not found", async () => {
    const response = await call("GET", {
      cookie: cookieFor("owner", OTHER_WORKSPACE),
    });
    expect(response.status).toBe(404);
    expect(
      (
        await call("PUT", {
          cookie: cookieFor("owner", OTHER_WORKSPACE),
          body: put(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("DELETE", {
          cookie: cookieFor("owner", OTHER_WORKSPACE),
        })
      ).status,
    ).toBe(404);
  });

  test("a malformed or oversized value is refused without echoing it", async () => {
    const owner = cookieFor("owner");
    for (const body of [
      put(`${VALUE} with spaces`),
      put(VALUE.slice(0, 5)),
      JSON.stringify({ value: VALUE, extra: VALUE }),
      `{"value": "${VALUE}"`,
    ]) {
      const response = await call("PUT", { cookie: owner, body });
      expect(response.status).toBe(400);
    }
    const huge = await call("PUT", {
      cookie: owner,
      body: put(`${VALUE}${"a".repeat(REQUEST_BODY_MAX_BYTES)}`),
    });
    expect(huge.status).toBe(413);
    expect(values.size).toBe(0);
  });

  test("without a master key every method answers 503", async () => {
    const off = appWith(null);
    const owner = cookieFor("owner");
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await off(method, {
        cookie: owner,
        ...(method === "PUT" ? { body: put() } : {}),
      });
      expect(response.status).toBe(503);
      expect(code(response.json).message).toContain("PLATFORM_SECRET_KEY");
    }
  });

  test("unauthenticated calls are 401", async () => {
    expect((await call("GET")).status).toBe(401);
  });
});

afterAll(() => {
  // The value went into requests above; it must come back in no response,
  // error body or log line, nor its middle in any form.
  const seen = [...responses, ...logs.records.map((r) => JSON.stringify(r))];
  for (const text of seen) {
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(VALUE.slice(7, 40));
  }
  expect(logs.records.length).toBeGreaterThan(0);
});
