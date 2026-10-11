import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentRelease,
  activateAgentResponseSchema,
  agentDetailSchema,
  apiErrorResponseSchema,
  createAgentReleaseResponseSchema,
  listAgentsResponseSchema,
} from "@agent-platform/contracts";
import {
  type AgentService,
  type AgentStore,
  type AuthorizationPolicy,
  type Caller,
  type CatalogProfile,
  createAgentService,
  createAuthorizationPolicy,
  deriveReleaseId,
  profileFingerprint,
} from "@agent-platform/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerAgentRoutes } from "./agents.ts";

const createApiApp = recordRouteErrors("routes/agents.test.ts");

const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const VERSION = "019a0000-0000-7000-8000-0000000000a2";
const OWNER_USER = "019a0000-0000-7000-8000-0000000000b1";
const RECEIPT = "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10";
const AT = "2026-10-11T00:00:00.000Z";

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep"],
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
};

const card = {
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  language: "ko" as const,
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  rules: [],
};

const detail: AgentDetail = {
  agent: {
    id: AGENT,
    workspace_id: "019a0000-0000-7000-8000-0000000000c1",
    slug: "finance",
    name: "재무 분석가",
    status: "active",
    active_release_id: null,
    activation_revision: -1,
    created_by: OWNER_USER,
    created_at: AT,
    updated_at: AT,
  },
  versions: [
    {
      id: VERSION,
      agent_id: AGENT,
      version_no: 1,
      card,
      content_sha256: "a".repeat(64),
      created_by: OWNER_USER,
      created_at: AT,
    },
  ],
  releases: [],
  active_release: null,
};

function storedRelease(profile: CatalogProfile = PROFILE): AgentRelease {
  const identity = {
    agent_id: AGENT,
    card_sha256: "a".repeat(64),
    runtime_profile_id: "coding",
    profile_digest: profileFingerprint(profile),
    runtime_config_snapshot: { model: "claude-sonnet-5" },
    effective_tools: { tools: ["Read"], mcp: [] },
    policy_pins: {
      tools: {
        default: { builtin: "allow", mcp: "ask" },
        per_tool: { Read: "allow" },
      },
    } as const,
  };
  return {
    id: deriveReleaseId(identity),
    version_id: VERSION,
    created_by: OWNER_USER,
    created_at: AT,
    approved_by: null,
    approved_at: null,
    ...identity,
  };
}

const allowing: AuthorizationPolicy = {
  authorize: async () => ({
    outcome: "allow",
    reason_code: "ok",
    effective_scopes: [],
    policy_version: "test",
    decision_id: crypto.randomUUID(),
  }),
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

function store(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    list: async () => [detail.agent],
    get: async () => detail,
    findVersion: async () => detail.versions[0] ?? null,
    findRelease: async () => storedRelease(),
    create: async () => ({ outcome: "created", detail }),
    update: async () => ({ outcome: "updated", detail }),
    insertRelease: async ({ release }) => ({
      outcome: "created",
      release: {
        ...release,
        created_at: AT,
        approved_by: null,
        approved_at: null,
      },
    }),
    activate: async () => ({
      outcome: "activated",
      revision: 0,
      previousReleaseId: null,
      receiptId: RECEIPT,
    }),
    ...overrides,
  };
}

function asPerson(caller: Caller): Caller {
  return {
    ...caller,
    actor: {
      principal: { kind: "user", id: OWNER_USER },
      userId: OWNER_USER,
      workspaceId: caller.ownerId,
      apiKeyId: null,
    },
  };
}

type Routed = Omit<AgentService, "resolveRelease">;

function app(
  agentStore: AgentStore = store(),
  options: { authorization?: AuthorizationPolicy; person?: boolean } = {},
) {
  const service = createAgentService({
    authorization: options.authorization ?? allowing,
    store: agentStore,
    catalog: { profiles: { coding: PROFILE }, repositories: {} },
  });
  const routed: Routed =
    options.person === false
      ? service
      : {
          listAgents: (caller) => service.listAgents(asPerson(caller)),
          getAgent: (caller, id) => service.getAgent(asPerson(caller), id),
          createAgent: (caller, body) =>
            service.createAgent(asPerson(caller), body),
          updateAgent: (caller, id, body) =>
            service.updateAgent(asPerson(caller), id, body),
          createRelease: (caller, id, body) =>
            service.createRelease(asPerson(caller), id, body),
          activateAgent: (caller, id, body) =>
            service.activateAgent(asPerson(caller), id, body),
        };
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerAgentRoutes(router, routed),
  });
}

const owner = { "X-Owner-Id": "owner-a" };

function send(
  api: ReturnType<typeof app>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = owner,
) {
  return api.request(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function codeOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

const oversized = JSON.stringify({ name: "x".repeat(65 * 1024) });
const keyOnly = () =>
  app(store(), { authorization: createAuthorizationPolicy(), person: false });

describe("GET /v1/agents", () => {
  test("lists the workspace's agents", async () => {
    const response = await send(app(), "GET", "/v1/agents");
    expect(response.status).toBe(200);
    expect(listAgentsResponseSchema.parse(await response.json())).toEqual({
      items: [detail.agent],
    });
  });

  test("refuses an API key whatever its scopes", async () => {
    const response = await send(keyOnly(), "GET", "/v1/agents");
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("FORBIDDEN");
  });

  test("requires authentication and maps an outage to 503", async () => {
    expect((await send(app(), "GET", "/v1/agents", undefined, {})).status).toBe(
      401,
    );
    expect(
      (await send(app(store({ list: outage })), "GET", "/v1/agents")).status,
    ).toBe(503);
  });
});

describe("POST /v1/agents", () => {
  const body = { slug: "finance", name: "재무 분석가", card };

  test("creates the agent with its first version", async () => {
    let created: unknown;
    const response = await send(
      app(
        store({
          create: async (input) => {
            created = input;
            return { outcome: "created", detail };
          },
        }),
      ),
      "POST",
      "/v1/agents",
      body,
    );
    expect(response.status).toBe(201);
    expect(agentDetailSchema.parse(await response.json())).toEqual(detail);
    expect(created).toMatchObject({
      slug: "finance",
      createdBy: OWNER_USER,
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("refuses a card that names an MCP server or a bad slug", async () => {
    for (const bad of [
      {
        ...body,
        card: { ...card, capabilities: { ...card.capabilities, mcp: [] } },
      },
      { ...body, slug: "Finance Team" },
      { ...body, card: { ...card, api_key: "x" } },
    ]) {
      const response = await send(app(), "POST", "/v1/agents", bad);
      expect(response.status).toBe(400);
    }
  });

  test("a taken slug is 409 ALREADY_EXISTS", async () => {
    const response = await send(
      app(store({ create: async () => ({ outcome: "slug_taken" }) })),
      "POST",
      "/v1/agents",
      body,
    );
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("ALREADY_EXISTS");
  });

  test("refuses an API key and an oversized body", async () => {
    expect((await send(keyOnly(), "POST", "/v1/agents", body)).status).toBe(
      403,
    );
    expect((await send(app(), "POST", "/v1/agents", oversized)).status).toBe(
      413,
    );
  });
});

describe("GET /v1/agents/{id}", () => {
  test("returns versions, releases and the active release", async () => {
    const response = await send(app(), "GET", `/v1/agents/${AGENT}`);
    expect(response.status).toBe(200);
    expect(agentDetailSchema.parse(await response.json())).toEqual(detail);
  });

  test("a missing agent and a malformed id are both not found", async () => {
    expect(
      (
        await send(
          app(store({ get: async () => null })),
          "GET",
          `/v1/agents/${AGENT}`,
        )
      ).status,
    ).toBe(404);
    expect((await send(app(), "GET", "/v1/agents/not-a-uuid")).status).toBe(
      404,
    );
  });

  test("refuses an API key", async () => {
    expect((await send(keyOnly(), "GET", `/v1/agents/${AGENT}`)).status).toBe(
      403,
    );
  });
});

describe("PATCH /v1/agents/{id}", () => {
  test("a card becomes a new version", async () => {
    let update: unknown;
    const response = await send(
      app(
        store({
          update: async (input) => {
            update = input;
            return { outcome: "updated", detail };
          },
        }),
      ),
      "PATCH",
      `/v1/agents/${AGENT}`,
      { card },
    );
    expect(response.status).toBe(200);
    expect(update).toMatchObject({
      agentId: AGENT,
      card: { card, contentSha256: expect.any(String) },
      updatedBy: OWNER_USER,
    });
  });

  test("refuses an empty patch, an unknown agent and an oversized body", async () => {
    expect((await send(app(), "PATCH", `/v1/agents/${AGENT}`, {})).status).toBe(
      400,
    );
    expect(
      (
        await send(
          app(store({ update: async () => ({ outcome: "not_found" }) })),
          "PATCH",
          `/v1/agents/${AGENT}`,
          { name: "x" },
        )
      ).status,
    ).toBe(404);
    expect(
      (await send(app(), "PATCH", `/v1/agents/${AGENT}`, oversized)).status,
    ).toBe(413);
    expect(
      (await send(keyOnly(), "PATCH", `/v1/agents/${AGENT}`, { name: "x" }))
        .status,
    ).toBe(403);
  });
});

describe("POST /v1/agents/{id}/releases", () => {
  const path = `/v1/agents/${AGENT}/releases`;
  const body = { version_id: VERSION, runtime_profile_id: "coding" };

  test("releases a version with a hash id and no credential", async () => {
    const response = await send(app(), "POST", path, body);
    expect(response.status).toBe(200);
    const released = createAgentReleaseResponseSchema.parse(
      await response.json(),
    );
    expect(released.created).toBe(true);
    expect(released.release.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(released.release.approved_by).toBeNull();
    expect(JSON.stringify(released)).not.toContain("catalog-provider-key");
  });

  test("a card tool outside the profile or an unknown profile is 422", async () => {
    const wide = {
      ...detail.versions[0],
      card: {
        ...card,
        capabilities: { ...card.capabilities, tools: ["Bash"] },
      },
    } as NonNullable<AgentDetail["versions"][0]>;
    const tooWide = await send(
      app(store({ findVersion: async () => wide })),
      "POST",
      path,
      body,
    );
    expect(tooWide.status).toBe(422);
    expect(await codeOf(tooWide)).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      (
        await send(app(), "POST", path, {
          ...body,
          runtime_profile_id: "missing",
        })
      ).status,
    ).toBe(422);
  });

  test("another agent's version is not found; a bad body is 400 or 413", async () => {
    expect(
      (
        await send(
          app(store({ findVersion: async () => null })),
          "POST",
          path,
          body,
        )
      ).status,
    ).toBe(404);
    expect((await send(app(), "POST", path, { version_id: "x" })).status).toBe(
      400,
    );
    expect((await send(app(), "POST", path, oversized)).status).toBe(413);
    expect((await send(keyOnly(), "POST", path, body)).status).toBe(403);
  });
});

describe("POST /v1/agents/{id}/activate", () => {
  const path = `/v1/agents/${AGENT}/activate`;
  const body = { release_id: storedRelease().id, expected_revision: -1 };

  test("moves the pointer and names the receipt", async () => {
    const response = await send(app(), "POST", path, body);
    expect(response.status).toBe(200);
    expect(activateAgentResponseSchema.parse(await response.json())).toEqual({
      active_release_id: body.release_id,
      previous_release_id: null,
      activation_revision: 0,
      receipt_id: RECEIPT,
    });
  });

  test("a stale revision is 409 REVISION_CONFLICT", async () => {
    const response = await send(
      app(
        store({
          activate: async () => ({
            outcome: "conflict",
            activeReleaseId: "sha256:other",
            revision: 4,
          }),
        }),
      ),
      "POST",
      path,
      body,
    );
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("REVISION_CONFLICT");
  });

  test("a release made against a since-changed profile is 409 PROFILE_DIGEST_MISMATCH", async () => {
    const stale = storedRelease({ ...PROFILE, tools: ["Read"] });
    const response = await send(
      app(store({ findRelease: async () => stale })),
      "POST",
      path,
      { ...body, release_id: stale.id },
    );
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("PROFILE_DIGEST_MISMATCH");
  });

  test("another agent's or a missing release is not found", async () => {
    const elsewhere = {
      ...storedRelease(),
      agent_id: "019a0000-0000-7000-8000-0000000000ff",
    };
    elsewhere.id = deriveReleaseId(elsewhere);
    for (const found of [null, elsewhere]) {
      const response = await send(
        app(store({ findRelease: async () => found })),
        "POST",
        path,
        body,
      );
      expect(response.status).toBe(404);
    }
  });

  test("refuses a bad body, an oversized one and an API key", async () => {
    expect(
      (
        await send(app(), "POST", path, {
          release_id: "x",
          expected_revision: -2,
        })
      ).status,
    ).toBe(400);
    expect((await send(app(), "POST", path, oversized)).status).toBe(413);
    expect((await send(keyOnly(), "POST", path, body)).status).toBe(403);
  });
});
