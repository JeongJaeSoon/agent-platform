import { describe, expect, test } from "bun:test";
import {
  type ApiKeyView,
  apiErrorResponseSchema,
  createApiKeyResponseSchema,
  listApiKeysResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  revokeApiKeyResponseSchema,
} from "@agent-platform/contracts";
import {
  type ApiKeyService,
  SessionServiceError,
} from "@agent-platform/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerApiKeyRoutes } from "./api-keys.ts";

const createApiApp = recordRouteErrors("routes/api-keys.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const KEY = "019a0000-0000-7000-8000-0000000000e1";
const SECRET = `csp_${"a".repeat(43)}`;
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };

const VIEW: ApiKeyView = {
  id: KEY,
  kind: "personal",
  workspace_id: WORKSPACE,
  agent_id: null,
  created_by: "019a0000-0000-7000-8000-0000000000a1",
  scopes: ["sessions:read"],
  created_at: "2026-10-11T00:00:00.000Z",
  expires_at: null,
  revoked_at: null,
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

function app(service: Partial<ApiKeyService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerApiKeyRoutes(router, service as ApiKeyService),
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

function create(api: ReturnType<typeof app>, body: unknown) {
  return api.request("/v1/api-keys", {
    method: "POST",
    headers: owner,
    body: JSON.stringify(body),
  });
}

describe("POST /v1/api-keys", () => {
  test("returns the secret once, uncached", async () => {
    const response = await create(
      app({
        issue: async () => ({ key: VIEW, secret: SECRET, receipt_id: KEY }),
      }),
      { kind: "personal", scopes: ["sessions:read"] },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(createApiKeyResponseSchema.parse(await response.json()).secret).toBe(
      SECRET,
    );
  });

  test("an oversized body is refused before the service", async () => {
    const response = await create(app({}), {
      kind: "personal",
      scopes: ["sessions:read"],
      pad: "x".repeat(REQUEST_BODY_MAX_BYTES),
    });
    expect(response.status).toBe(413);
  });

  test("a personal key bound to an agent is malformed", async () => {
    const response = await create(app({}), {
      kind: "personal",
      scopes: ["sessions:read"],
      agent_id: KEY,
    });
    expect(response.status).toBe(400);
  });

  test("a refusal names the policy's reason", async () => {
    const response = await create(
      app({
        issue: async () => {
          throw new SessionServiceError("FORBIDDEN", "no", undefined, {
            reason_code: "role",
          });
        },
      }),
      { kind: "service", scopes: ["sessions:read"] },
    );
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    });
  });

  test("scopes above the issuer answer SCOPE_NOT_GRANTABLE", async () => {
    const response = await create(
      app({
        issue: async () => {
          throw new SessionServiceError("SCOPE_NOT_GRANTABLE", "no");
        },
      }),
      { kind: "service", scopes: ["sessions:recover"] },
    );
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("SCOPE_NOT_GRANTABLE");
  });

  test("an unknown agent and an outage", async () => {
    const missing = await create(
      app({
        issue: async () => {
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        },
      }),
      { kind: "service", scopes: ["sessions:read"], agent_id: KEY },
    );
    expect(missing.status).toBe(404);
    const down = await create(app({ issue: outage }), {
      kind: "personal",
      scopes: ["sessions:read"],
    });
    expect(down.status).toBe(503);
  });
});

describe("GET /v1/api-keys", () => {
  test("lists, refuses and fails closed", async () => {
    const listed = await app({
      list: async () => ({ items: [VIEW] }),
    }).request("/v1/api-keys", { headers: owner });
    expect(listed.status).toBe(200);
    expect(
      listApiKeysResponseSchema.parse(await listed.json()).items,
    ).toHaveLength(1);

    const refused = await app({
      list: async () => {
        throw new SessionServiceError("FORBIDDEN", "no");
      },
    }).request("/v1/api-keys", { headers: owner });
    expect(refused.status).toBe(403);

    const down = await app({ list: outage }).request("/v1/api-keys", {
      headers: owner,
    });
    expect(down.status).toBe(503);
  });
});

describe("DELETE /v1/api-keys/{id}", () => {
  function revoke(service: Partial<ApiKeyService>, id = KEY) {
    return app(service).request(`/v1/api-keys/${id}`, {
      method: "DELETE",
      headers: owner,
    });
  }

  test("revokes, and a second revoke has no receipt", async () => {
    let asked: string | undefined;
    const response = await revoke({
      revoke: async (_caller, id) => {
        asked = id;
        return { key: VIEW, receipt_id: null };
      },
    });
    expect(response.status).toBe(200);
    expect(asked).toBe(KEY);
    expect(
      revokeApiKeyResponseSchema.parse(await response.json()).receipt_id,
    ).toBeNull();
  });

  test("a malformed id, a refusal and an outage", async () => {
    expect((await revoke({}, "not-a-key")).status).toBe(404);
    expect(
      (
        await revoke({
          revoke: async () => {
            throw new SessionServiceError("FORBIDDEN", "no");
          },
        })
      ).status,
    ).toBe(403);
    expect((await revoke({ revoke: outage })).status).toBe(503);
  });
});
