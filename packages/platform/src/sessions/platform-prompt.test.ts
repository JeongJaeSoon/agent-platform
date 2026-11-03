import { describe, expect, test } from "bun:test";
import type { AuthorizationSurface } from "@werft-ai/contracts";
import {
  platformPromptOf,
  platformPromptRevisionFromEnv,
} from "./platform-prompt.ts";
import type { SessionCatalog } from "./catalog.ts";
import { withSeededInstallation } from "./profile-registry.ts";

const profile: SessionCatalog["profiles"][string] = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "test",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const catalog = withSeededInstallation({
  profiles: { "coding-v1": profile },
  repositories: {},
});

const promptFrom = (surface: AuthorizationSurface) =>
  platformPromptOf({
    identity: { name: "a", description: null, language: "ko" },
    surface,
    catalog,
    profileId: "coding-v1",
    repository: null,
    github: null,
  }).origin_surface;

describe("platformPromptOf", () => {
  test("names where the session started by the kind of surface, a Slack DM apart from a channel", () => {
    expect(promptFrom({ kind: "web" })).toBe("console");
    expect(promptFrom({ kind: "api" })).toBe("api");
    expect(promptFrom({ kind: "slack", channel_kind: "dm" })).toBe("slack_dm");
    for (const channel_kind of ["public_channel", "private_channel"] as const) {
      expect(promptFrom({ kind: "slack", channel_kind })).toBe("slack_channel");
    }
  });
});

describe("platformPromptRevisionFromEnv", () => {
  test("unset or empty is 0; 0 and 1 are read; anything else refuses to start", () => {
    expect(platformPromptRevisionFromEnv({})).toBe(0);
    expect(platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: "" })).toBe(
      0,
    );
    expect(
      platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: "1" }),
    ).toBe(1);
    expect(
      platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: "0" }),
    ).toBe(0);
    for (const bad of ["2", "true", " 1", "01"]) {
      expect(() =>
        platformPromptRevisionFromEnv({ SESSION_PROMPT_REVISION: bad }),
      ).toThrow("SESSION_PROMPT_REVISION must be one of 0, 1");
    }
  });
});
