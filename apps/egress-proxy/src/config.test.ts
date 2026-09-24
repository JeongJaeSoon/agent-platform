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
      credential: null,
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

  test("the credential routes need the authorizer's address and token together", () => {
    const base = { EGRESS_ALLOWLIST: "a.test:443" };
    const token = "authorizer-token-for-tests-0123456789";
    expect(
      egressProxyConfigFromEnv({
        ...base,
        EGRESS_AUTHORIZER_URL: "http://api:3100",
        EGRESS_AUTHORIZER_TOKEN: token,
      }).credential,
    ).toEqual({
      allow: [],
      allowPrivate: [],
      authorizerToken: token,
      authorizerUrl: "http://api:3100/",
      port: 3129,
    });
    expect(
      egressProxyConfigFromEnv({
        ...base,
        EGRESS_AUTHORIZER_URL: "http://api:3100",
        EGRESS_AUTHORIZER_TOKEN: token,
        EGRESS_CREDENTIAL_PORT: "4000",
      }).credential?.port,
    ).toBe(4000);
    // The object store is reached by the credential routes only (94S-251).
    const routed = egressProxyConfigFromEnv({
      ...base,
      EGRESS_AUTHORIZER_URL: "http://api:3100",
      EGRESS_AUTHORIZER_TOKEN: token,
      EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "localstack:4566",
    });
    expect(routed.credential?.allowPrivate).toEqual([
      { host: "localstack", port: 4566 },
    ]);
    expect(routed.allowPrivate).toEqual([]);
    expect(() =>
      egressProxyConfigFromEnv({
        ...base,
        EGRESS_AUTHORIZER_URL: "http://api:3100",
      }),
    ).toThrow("set together");
    expect(() =>
      egressProxyConfigFromEnv({ ...base, EGRESS_AUTHORIZER_TOKEN: token }),
    ).toThrow("set together");
    expect(() =>
      egressProxyConfigFromEnv({
        ...base,
        EGRESS_AUTHORIZER_URL: "http://api:3100",
        EGRESS_AUTHORIZER_TOKEN: "short",
      }),
    ).toThrow("at least 32");
    expect(() =>
      egressProxyConfigFromEnv({
        ...base,
        EGRESS_AUTHORIZER_URL: "file:///x",
        EGRESS_AUTHORIZER_TOKEN: token,
      }),
    ).toThrow("http or https");
  });
});
