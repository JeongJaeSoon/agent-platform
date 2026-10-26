import { expect, test } from "bun:test";
import {
  listProfilesResponseSchema,
  type SessionScope,
} from "@werft-ai/contracts";
import type { SessionCatalog } from "@werft-ai/platform";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerProfileRoutes } from "./profiles.ts";

const createApiApp = recordRouteErrors("routes/profiles.test.ts");

const PROVIDER_SECRET = "sk-test-provider-secret";

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
          ref: { secret_id: "litellm/key" },
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

function appWithKey(scopes: SessionScope[]) {
  const plaintext = `csp_${crypto.randomUUID()}`;
  const keyHash = Buffer.from(hashApiKey(plaintext));
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
    registerRoutes: (router) => registerProfileRoutes(router, catalog),
  });
  return (path: string) =>
    app.request(path, { headers: { Authorization: `Bearer ${plaintext}` } });
}

test("lists every profile by id with the model, and nothing of the provider", async () => {
  const response = await appWithKey(["sessions:read"])("/v1/profiles");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(listProfilesResponseSchema.parse(JSON.parse(text))).toEqual({
    items: [
      {
        id: "alpha-real",
        model: "claude-sonnet-5",
        tools: ["Read", "Edit"],
        runtime_kind: "claude_agent_sdk",
        runtime_version: "0.3.270",
        billing: "metered",
        repository_mode: "required",
        repository_ids: ["sample-app"],
      },
      {
        id: "zeta-local",
        model: "qwen3-coder",
        tools: ["Read"],
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
    "litellm/key",
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
  const response = await appWithKey(["sessions:write"])("/v1/profiles");
  expect(response.status).toBe(403);
});
