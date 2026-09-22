import { describe, expect, test } from "bun:test";
import type { ClaudeRuntimeConfig } from "./config.ts";
import {
  publicProfile,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "./profile.ts";

const baseConfig: ClaudeRuntimeConfig = {
  claudeConfigDir: "/tenant/config",
  correlationId: "corr-1",
  mode: "new",
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

const policy = {
  endpoints: ["https://api.anthropic.com"],
  models: ["primary"],
};
const mirror = {
  async append() {},
  async listSubkeys() {
    return [];
  },
  async load() {
    return null;
  },
};

describe("runtime profiles", () => {
  test("refuses to resume against a mirror that is not revision-scoped", () => {
    // The live mirror still holds whatever was written after the checkpoint
    // being resumed; replaying that is a different conversation.
    expect(() =>
      validateRuntimeConfig(
        {
          ...baseConfig,
          mode: "resume",
          resume: "sdk-session-1",
          sessionStore: mirror,
        },
        policy,
      ),
    ).toThrow(/revision-scoped/);
  });

  test("refuses to resume with no mirror at all", () => {
    // The omission is the dangerous case: nothing here says "restore", the
    // engine falls back to the container's own CLAUDE_CONFIG_DIR, and the
    // session silently continues from whatever that disk happens to hold.
    expect(() =>
      validateRuntimeConfig(
        { ...baseConfig, mode: "resume", resume: "sdk-session-1" },
        policy,
      ),
    ).toThrow(/revision-scoped/);
  });

  test("resumes from local disk only when the caller says so", () => {
    const config = {
      ...baseConfig,
      localTranscriptResume: true as const,
      mode: "resume" as const,
      resume: "sdk-session-1",
    };

    expect(validateRuntimeConfig(config, policy)).toBe(config);
  });

  test("resumes against a mirror pinned to the restored revision", () => {
    const config = {
      ...baseConfig,
      mode: "resume" as const,
      resume: "sdk-session-1",
      sessionStore: { ...mirror, revisionScoped: true },
    };

    expect(validateRuntimeConfig(config, policy)).toBe(config);
  });

  test("a fresh run may take the live mirror", () => {
    const config = { ...baseConfig, sessionStore: mirror };

    expect(validateRuntimeConfig(config, policy)).toBe(config);
  });

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

  test("forwards the host's egress proxy variables and nothing else", () => {
    // On the worker network the proxy is the only route to the Messages
    // endpoint (94S-199); the engine only learns it through these.
    const environment = runtimeEnvironment(baseConfig, {
      ALL_PROXY: "socks5://must-not-pass",
      ANTHROPIC_API_KEY: "host-key-must-not-pass",
      ANTHROPIC_BASE_URL: "https://host.example.com",
      HTTP_PROXY: "http://egress-proxy:3128",
      HTTPS_PROXY: "http://egress-proxy:3128",
      NODE_EXTRA_CA_CERTS: "/etc/egress/ca.pem",
      NODE_OPTIONS: "--must-not-pass",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NO_PROXY: "localhost,127.0.0.1,::1",
      PATH: "/bin",
      SSL_CERT_FILE: "/must/not/pass",
      http_proxy: "http://egress-proxy:3128",
      https_proxy: "http://egress-proxy:3128",
      no_proxy: "localhost,127.0.0.1,::1",
    });
    expect(environment).toEqual({
      ANTHROPIC_API_KEY: "placeholder-direct",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: "/tenant/config",
      HOME: "/tenant/home",
      HTTP_PROXY: "http://egress-proxy:3128",
      HTTPS_PROXY: "http://egress-proxy:3128",
      LANG: "en_US.UTF-8",
      NODE_EXTRA_CA_CERTS: "/etc/egress/ca.pem",
      NO_PROXY: "localhost,127.0.0.1,::1",
      PATH: "/bin",
      TMPDIR: expect.any(String),
      http_proxy: "http://egress-proxy:3128",
      https_proxy: "http://egress-proxy:3128",
      no_proxy: "localhost,127.0.0.1,::1",
    });
  });

  test("forwards each proxy variable only when the host sets it", () => {
    // A lowercase-only host must not grow uppercase twins the engine would
    // then read with a different precedence than the host intended.
    const environment = runtimeEnvironment(baseConfig, {
      PATH: "/bin",
      https_proxy: "http://egress-proxy:3128",
    });
    expect(environment.https_proxy).toBe("http://egress-proxy:3128");
    expect("HTTPS_PROXY" in environment).toBe(false);
    expect("HTTP_PROXY" in environment).toBe(false);
    expect("NO_PROXY" in environment).toBe(false);
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
