import { describe, expect, test } from "bun:test";

import {
  publicProfile,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "./profile.ts";
import type { RuntimeConfig } from "./runtime.ts";

const baseConfig: RuntimeConfig = {
  claudeConfigDir: "/tenant/config",
  correlationId: "corr-1",
  cwd: "/tenant/workspace",
  home: "/tenant/home",
  model: "primary",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value: "placeholder-direct" },
  },
  tools: ["Read", "Edit"],
};

describe("runtime profiles", () => {
  test("accepts only approved endpoints and model aliases", () => {
    expect(
      validateRuntimeConfig(baseConfig, {
        endpoints: ["https://api.anthropic.com/"],
        models: ["primary"],
      }),
    ).toBe(baseConfig);
    expect(() =>
      validateRuntimeConfig(baseConfig, {
        endpoints: ["https://proxy.example.com"],
        models: ["primary"],
      }),
    ).toThrow("endpoint");
    expect(() =>
      validateRuntimeConfig(baseConfig, {
        endpoints: ["https://api.anthropic.com"],
        models: ["unapproved"],
      }),
    ).toThrow("model");
  });

  test("builds a minimal direct API environment without copying the host", () => {
    const environment = runtimeEnvironment(baseConfig, {
      PATH: "/bin",
      LANG: "C.UTF-8",
      HOST_PRIVATE_VALUE: "must-not-pass",
    });
    expect(environment).toEqual({
      ANTHROPIC_API_KEY: "placeholder-direct",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: "/tenant/config",
      HOME: "/tenant/home",
      LANG: "C.UTF-8",
      PATH: "/bin",
      TMPDIR: expect.any(String),
    });
    expect(environment.HOST_PRIVATE_VALUE).toBeUndefined();
  });

  test("uses the profile-specific LiteLLM authentication transport", () => {
    const bearer = runtimeEnvironment({
      ...baseConfig,
      profile: {
        kind: "litellm",
        endpoint: "https://proxy.example.com/v1",
        auth: { kind: "bearer", value: "placeholder-bearer" },
      },
    });
    expect(bearer.ANTHROPIC_AUTH_TOKEN).toBe("placeholder-bearer");
    expect(bearer.ANTHROPIC_API_KEY).toBeUndefined();
    expect(publicProfile(baseConfig.profile)).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth_kind: "api_key",
    });
  });
});
