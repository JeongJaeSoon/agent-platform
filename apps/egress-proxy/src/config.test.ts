import { describe, expect, test } from "bun:test";
import { egressProxyConfigFromEnv } from "./config.ts";

describe("egressProxyConfigFromEnv", () => {
  test("reads both lists and the listen address", () => {
    expect(
      egressProxyConfigFromEnv({
        EGRESS_ALLOWLIST: "api.anthropic.com:443,github.com:443",
        EGRESS_PRIVATE_ALLOWLIST: "host.docker.internal:3000",
        EGRESS_PROXY_HOST: "127.0.0.1",
        EGRESS_PROXY_PORT: "8080",
        LOG_LEVEL: "warn",
      }),
    ).toEqual({
      allow: [
        { host: "api.anthropic.com", port: 443 },
        { host: "github.com", port: 443 },
      ],
      allowPrivate: [{ host: "host.docker.internal", port: 3000 }],
      hostname: "127.0.0.1",
      logLevel: "warn",
      port: 8080,
    });
  });

  test("defaults the port, address and level", () => {
    expect(
      egressProxyConfigFromEnv({ EGRESS_ALLOWLIST: "api.anthropic.com:443" }),
    ).toMatchObject({ hostname: "0.0.0.0", logLevel: "info", port: 3128 });
  });

  test("an empty policy is a misconfiguration, not a lockdown", () => {
    expect(() => egressProxyConfigFromEnv({})).toThrow("at least one");
  });

  test("a malformed entry or port fails at startup", () => {
    expect(() =>
      egressProxyConfigFromEnv({ EGRESS_ALLOWLIST: "api.anthropic.com" }),
    ).toThrow("EGRESS_ALLOWLIST");
    expect(() =>
      egressProxyConfigFromEnv({
        EGRESS_ALLOWLIST: "a.test:443",
        EGRESS_PROXY_PORT: "70000",
      }),
    ).toThrow("EGRESS_PROXY_PORT");
  });
});
