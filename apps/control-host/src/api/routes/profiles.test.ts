import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type InstallationProfileOptionsResponse,
  installationProfileChangeResponseSchema,
  installationProfileOptionsResponseSchema,
  listProfilesResponseSchema,
  type ProfileSummary,
  REQUEST_BODY_MAX_BYTES,
  type SessionScope,
  workspaceProfileChangeResponseSchema,
} from "@werft-ai/contracts";
import {
  createWorkspaceProfileService,
  type InstallationProfileService,
  type SessionCatalog,
  SessionServiceError,
  type WorkspaceProfileService,
} from "@werft-ai/platform";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerProfileRoutes } from "./profiles.ts";

const createApiApp = recordRouteErrors("routes/profiles.test.ts");

const PROVIDER_SECRET = "provider-secret-value-0123456789";
const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

const catalog: SessionCatalog = {
  profiles: {
    "zeta-local": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "qwen3-coder",
      tools: ["Read"],
      permission_mode: "default",
      repository: "none",
      provider: {
        kind: "litellm",
        endpoint: "http://litellm.internal:4000",
        billing: "none",
        auth: {
          kind: "bearer",
          value: PROVIDER_SECRET,
          ref: { secret_id: "litellm-key-ref" },
        },
      },
    },
    "alpha-real": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit"],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: {
          kind: "api_key",
          value: PROVIDER_SECRET,
          ref: { value_env: "ANTHROPIC_API_KEY" },
        },
      },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://github.com/acme/sample-app",
      branch: "main",
      profiles: ["alpha-real"],
    },
  },
};

function listingWithKey(scopes: SessionScope[]) {
  const plaintext = `csp_${crypto.randomUUID()}`;
  const keyHash = Buffer.from(hashApiKey(plaintext));
  const service = createWorkspaceProfileService({
    authorization: {} as never,
    store: {} as never,
    catalog: {
      ...catalog,
      workspace_profiles: { records: new Map(), refresh: async () => {} },
    },
  });
  const app = createApiApp({
    authMode: "api-key",
    keyStore: {
      async find(candidate) {
        return keyHash.equals(Buffer.from(candidate))
          ? {
              id: "key-a",
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes,
            }
          : null;
      },
    },
    registerRoutes: (router) =>
      registerProfileRoutes(router, service, {} as InstallationProfileService),
  });
  return (path: string) =>
    app.request(path, { headers: { Authorization: `Bearer ${plaintext}` } });
}

describe("GET /v1/profiles", () => {
  test("lists every profile by id with the model, and nothing of the provider", async () => {
    const response = await listingWithKey(["sessions:read"])("/v1/profiles");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(listProfilesResponseSchema.parse(JSON.parse(text))).toEqual({
      items: [
        {
          id: "alpha-real",
          source: "operator",
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          tools: ["Read", "Edit"],
          permission_mode: "default",
          runtime_kind: "claude_agent_sdk",
          runtime_version: "0.3.270",
          billing: "metered",
          repository_mode: "required",
          repository_ids: ["sample-app"],
        },
        {
          id: "zeta-local",
          source: "operator",
          model: "qwen3-coder",
          models: ["qwen3-coder"],
          tools: ["Read"],
          permission_mode: "default",
          runtime_kind: "claude_agent_sdk",
          runtime_version: "0.3.270",
          billing: "none",
          repository_mode: "none",
          repository_ids: [],
        },
      ],
    });
    for (const leaked of [
      PROVIDER_SECRET,
      "ANTHROPIC_API_KEY",
      "litellm-key-ref",
      "value_env",
      "secret_id",
      "endpoint",
      "api.anthropic.com",
      "litellm.internal",
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("refuses a key without the read scope", async () => {
    const response = await listingWithKey(["sessions:write"])("/v1/profiles");
    expect(response.status).toBe(403);
  });
});

const VERSION: ProfileSummary = {
  id: "ws_acme_strict-review_v1",
  source: "workspace",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read"],
  permission_mode: "plan",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  billing: "metered",
  repository_mode: "required",
  workspace: {
    name: "strict-review",
    version: 1,
    base_profile_id: "alpha-real",
    state: "usable",
    created_at: "2026-10-27T00:00:00.000Z",
    retired_at: null,
  },
};
const REQUEST = {
  name: "strict-review",
  base_profile_id: "alpha-real",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read"],
  permission_mode: "plan",
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const refusing = (code: string) => async () => {
  throw new SessionServiceError(code as never, "no", undefined, {
    reason_code: "role",
  });
};

function app(
  profiles: Partial<WorkspaceProfileService>,
  installation: Partial<InstallationProfileService> = {},
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerProfileRoutes(
        router,
        profiles as WorkspaceProfileService,
        installation as InstallationProfileService,
      ),
  });
}

function post(
  profiles: Partial<WorkspaceProfileService>,
  path: string,
  body?: unknown,
) {
  return app(profiles).request(path, {
    method: "POST",
    headers: { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function onInstallation(
  installation: Partial<InstallationProfileService>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return app({}, installation).request(path, {
    method,
    headers: { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function codeOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("POST /v1/workspace-profiles", () => {
  test("saves a version, and every refusal maps to its status", async () => {
    let asked: unknown;
    const created = await post(
      {
        create: async (_caller, request) => {
          asked = request;
          return { profile: VERSION, receipt_id: RECEIPT };
        },
      },
      "/v1/workspace-profiles",
      REQUEST,
    );
    expect(created.status).toBe(201);
    expect(asked).toEqual(REQUEST);
    expect(
      workspaceProfileChangeResponseSchema.parse(await created.json()),
    ).toEqual({ profile: VERSION, receipt_id: RECEIPT });

    for (const bad of [
      { ...REQUEST, name: "Strict_Review" },
      { ...REQUEST, models: [] },
      { ...REQUEST, extra: true },
    ]) {
      const response = await post({}, "/v1/workspace-profiles", bad);
      expect(response.status).toBe(400);
    }
    const widened = await post(
      { create: refusing("BAD_REQUEST") },
      "/v1/workspace-profiles",
      REQUEST,
    );
    expect(widened.status).toBe(400);
    expect(
      (
        await post({}, "/v1/workspace-profiles", {
          ...REQUEST,
          pad: "x".repeat(REQUEST_BODY_MAX_BYTES),
        })
      ).status,
    ).toBe(413);
    const forbidden = await post(
      { create: refusing("FORBIDDEN") },
      "/v1/workspace-profiles",
      REQUEST,
    );
    expect(forbidden.status).toBe(403);
    const raced = await post(
      { create: refusing("REVISION_CONFLICT") },
      "/v1/workspace-profiles",
      REQUEST,
    );
    expect(raced.status).toBe(409);
    expect(await codeOf(raced)).toBe("REVISION_CONFLICT");
    expect(
      (await post({ create: outage }, "/v1/workspace-profiles", REQUEST))
        .status,
    ).toBe(503);
  });
});

describe("POST /v1/workspace-profiles/{profile_id}/retire", () => {
  const path = `/v1/workspace-profiles/${VERSION.id}/retire`;

  test("retires, and every refusal maps to its status", async () => {
    let asked: unknown;
    const retired = await post(
      {
        retire: async (_caller, profileId) => {
          asked = profileId;
          return { profile: VERSION, receipt_id: null };
        },
      },
      path,
    );
    expect(retired.status).toBe(200);
    expect(asked).toBe(VERSION.id);
    expect((await post({ retire: refusing("FORBIDDEN") }, path)).status).toBe(
      403,
    );
    const missing = await post({ retire: refusing("NOT_FOUND") }, path);
    expect(missing.status).toBe(404);
    expect((await post({ retire: outage }, path)).status).toBe(503);
  });
});

const CEILING: ProfileSummary = {
  id: "op_coding_v1",
  source: "operator",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read"],
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  billing: "metered",
  repository_mode: "required",
  repository_ids: ["sample-app"],
  installation: {
    name: "coding",
    version: 1,
    origin: "console",
    state: "usable",
    connection_id: "main",
    title_model: null,
    project_settings: { claude_md: false },
    previous_id: null,
    created_by: "019a0000-0000-7000-8000-0000000000b1",
    created_at: "2026-10-28T00:00:00.000Z",
    retired_by: null,
    retired_at: null,
  },
};
const CEILING_REQUEST = {
  name: "coding",
  connection_id: "main",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read"],
  permission_mode: "default",
  repository_ids: ["sample-app"],
};

describe("GET /v1/installation-profiles/options", () => {
  const path = "/v1/installation-profiles/options";

  test("answers the options, and every refusal maps to its status", async () => {
    const options: InstallationProfileOptionsResponse = {
      connections: [{ id: "main", kind: "anthropic", billing: "metered" }],
      runtimes: [
        { runtime_kind: "claude_agent_sdk", permission_modes: ["default"] },
      ],
      repositories: [{ id: "sample-app" }],
      unattended_allowed: false,
    };
    const answered = await onInstallation(
      { options: async () => structuredClone(options) },
      "GET",
      path,
    );
    expect(answered.status).toBe(200);
    expect(
      installationProfileOptionsResponseSchema.parse(await answered.json()),
    ).toEqual(options);
    expect(
      (await onInstallation({ options: refusing("FORBIDDEN") }, "GET", path))
        .status,
    ).toBe(403);
    expect(
      (await onInstallation({ options: outage }, "GET", path)).status,
    ).toBe(503);
  });
});

describe("POST /v1/installation-profiles", () => {
  const path = "/v1/installation-profiles";

  test("saves a ceiling, and every refusal maps to its status", async () => {
    let asked: unknown;
    const created = await onInstallation(
      {
        create: async (_caller, request) => {
          asked = request;
          return { profile: CEILING, receipt_id: RECEIPT };
        },
      },
      "POST",
      path,
      CEILING_REQUEST,
    );
    expect(created.status).toBe(201);
    expect(asked).toEqual(CEILING_REQUEST);
    expect(
      installationProfileChangeResponseSchema.parse(await created.json()),
    ).toEqual({ profile: CEILING, receipt_id: RECEIPT });
    for (const bad of [
      { ...CEILING_REQUEST, name: "Coding" },
      { ...CEILING_REQUEST, models: [] },
      { ...CEILING_REQUEST, permission_mode: "yolo" },
      { ...CEILING_REQUEST, endpoint: "https://elsewhere.invalid" },
    ]) {
      expect((await onInstallation({}, "POST", path, bad)).status).toBe(400);
    }
    expect(
      (
        await onInstallation(
          { create: refusing("BAD_REQUEST") },
          "POST",
          path,
          CEILING_REQUEST,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await onInstallation({}, "POST", path, {
          ...CEILING_REQUEST,
          pad: "x".repeat(REQUEST_BODY_MAX_BYTES),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await onInstallation(
          { create: refusing("FORBIDDEN") },
          "POST",
          path,
          CEILING_REQUEST,
        )
      ).status,
    ).toBe(403);
    const raced = await onInstallation(
      { create: refusing("REVISION_CONFLICT") },
      "POST",
      path,
      CEILING_REQUEST,
    );
    expect(raced.status).toBe(409);
    expect(await codeOf(raced)).toBe("REVISION_CONFLICT");
    expect(
      (await onInstallation({ create: outage }, "POST", path, CEILING_REQUEST))
        .status,
    ).toBe(503);
  });
});

describe("POST /v1/installation-profiles/{profile_id}/retire", () => {
  const path = `/v1/installation-profiles/${CEILING.id}/retire`;

  test("retires, and every refusal maps to its status", async () => {
    let asked: unknown;
    const retired = await onInstallation(
      {
        retire: async (_caller, profileId) => {
          asked = profileId;
          return { profile: CEILING, receipt_id: null };
        },
      },
      "POST",
      path,
    );
    expect(retired.status).toBe(200);
    expect(asked).toBe(CEILING.id);
    expect(
      (await onInstallation({ retire: refusing("FORBIDDEN") }, "POST", path))
        .status,
    ).toBe(403);
    expect(
      (await onInstallation({ retire: refusing("NOT_FOUND") }, "POST", path))
        .status,
    ).toBe(404);
    expect(
      (await onInstallation({ retire: outage }, "POST", path)).status,
    ).toBe(503);
  });
});
