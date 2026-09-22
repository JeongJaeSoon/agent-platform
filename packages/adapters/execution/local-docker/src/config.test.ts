import { describe, expect, test } from "bun:test";
import { localDockerConfigFromEnv } from "./config.ts";

const base = {
  EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
  WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
};

describe("localDockerConfigFromEnv", () => {
  test("applies the documented defaults", () => {
    expect(localDockerConfigFromEnv(base)).toEqual({
      allowedNetworks: ["agent-platform-worker"],
      apiVersion: "v1.44",
      dockerHost: "unix:///var/run/docker.sock",
      egressProxyUrl: "http://egress-proxy:3128",
      gatewayUrl: "http://host.docker.internal:3000",
      homeDir: "/home/worker",
      installationId: "local",
      network: "agent-platform-worker",
      requestTimeoutMs: 30_000,
      stopTimeoutSeconds: 10,
      tmpfsSizeBytes: 256 * 1024 * 1024,
      user: "1000:1000",
      workspaceDir: "/workspace",
      workspaceGcMinAgeMs: 3_600_000,
      workspaceQuota: { mode: "enforced", sizeBytes: 4096 * 1024 * 1024 },
    });
  });

  test("the workspace quota is on unless it is turned off by name", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA: "off",
      }).workspaceQuota,
    ).toEqual({ mode: "off" });
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_QUOTA_MB: "512",
      }).workspaceQuota,
    ).toEqual({ mode: "enforced", sizeBytes: 512 * 1024 * 1024 });
  });

  test("a value that is neither on nor off is a typo, not an opt-out", () => {
    // "false", "0" and "no" all have to fail loudly: read as an opt-out they
    // would silently remove the ceiling the operator thinks they set.
    for (const value of ["false", "0", "no", "OFF"]) {
      expect(() =>
        localDockerConfigFromEnv({
          ...base,
          EXECUTION_WORKSPACE_QUOTA: value,
        }),
      ).toThrow('must be "on" or "off"');
    }
  });

  test("a quota of zero is refused, a GC age of zero is not", () => {
    expect(() =>
      localDockerConfigFromEnv({ ...base, EXECUTION_WORKSPACE_QUOTA_MB: "0" }),
    ).toThrow("EXECUTION_WORKSPACE_QUOTA_MB must be a positive integer");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_GC_MIN_AGE_SEC: "-1",
      }),
    ).toThrow(
      "EXECUTION_WORKSPACE_GC_MIN_AGE_SEC must be a non-negative integer",
    );
    // Zero says "reclaim as soon as the session is finished with it", which
    // is what the tests that want a deterministic pass ask for.
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_WORKSPACE_GC_MIN_AGE_SEC: "0",
      }).workspaceGcMinAgeMs,
    ).toBe(0);
  });

  test("an entrypoint override is split on whitespace and omitted when empty", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_COMMAND: " sleep  600 ",
      }).command,
    ).toEqual(["sleep", "600"]);
    expect("command" in localDockerConfigFromEnv(base)).toBe(false);
  });

  test("requires the gateway URL and rejects a non-URL", () => {
    expect(() => localDockerConfigFromEnv({})).toThrow("WORKER_GATEWAY_URL");
    expect(() =>
      localDockerConfigFromEnv({ ...base, WORKER_GATEWAY_URL: "not a url" }),
    ).toThrow("WORKER_GATEWAY_URL");
  });

  test("requires an http egress proxy URL", () => {
    expect(() =>
      localDockerConfigFromEnv({
        WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
      }),
    ).toThrow("EXECUTION_EGRESS_PROXY_URL");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_EGRESS_PROXY_URL: "egress-proxy:3128",
      }),
    ).toThrow("EXECUTION_EGRESS_PROXY_URL");
    // A proxy is addressed over http even when it tunnels TLS.
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_EGRESS_PROXY_URL: "https://egress-proxy:3128",
      }),
    ).toThrow("http://");
  });

  test("the network must be on the allowlist", () => {
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_NETWORK: "ap-workers",
      }),
    ).toThrow("allowlist");
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_NETWORK: "ap-workers",
        EXECUTION_DOCKER_NETWORK_ALLOWLIST: "ap-workers, ap-workers-2",
      }),
    ).toMatchObject({
      allowedNetworks: ["ap-workers", "ap-workers-2"],
      network: "ap-workers",
    });
  });

  test("a network that can never be internal is refused even if allowlisted", () => {
    // An allowlist entry only says the operator meant this name; these four
    // can never satisfy the isolation contract whatever the operator meant.
    for (const network of ["bridge", "default", "host", "none"]) {
      expect(() =>
        localDockerConfigFromEnv({
          ...base,
          EXECUTION_DOCKER_NETWORK: network,
          EXECUTION_DOCKER_NETWORK_ALLOWLIST: network,
        }),
      ).toThrow("never allowed");
    }
  });

  test("the worker user must not be root", () => {
    for (const user of [
      "0",
      "0:0",
      "00",
      "000:1000",
      "1000:0",
      "root",
      "worker",
      "",
    ]) {
      expect(() =>
        localDockerConfigFromEnv({ ...base, EXECUTION_DOCKER_USER: user }),
      ).toThrow("non-root");
    }
  });

  test("home and workspace must be distinct absolute paths", () => {
    expect(() =>
      localDockerConfigFromEnv({ ...base, EXECUTION_DOCKER_HOME_DIR: "home" }),
    ).toThrow("absolute");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_HOME_DIR: "/workspace",
      }),
    ).toThrow("differ");
  });

  test("the installation id must be label-safe", () => {
    expect(
      localDockerConfigFromEnv({ ...base, EXECUTION_INSTALLATION_ID: "prod-a" })
        .installationId,
    ).toBe("prod-a");
    expect(() =>
      localDockerConfigFromEnv({ ...base, EXECUTION_INSTALLATION_ID: "a b" }),
    ).toThrow("EXECUTION_INSTALLATION_ID");
  });

  test("the Docker request deadline is configured in seconds", () => {
    expect(
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC: "5",
      }).requestTimeoutMs,
    ).toBe(5_000);
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC: "0",
      }),
    ).toThrow("EXECUTION_DOCKER_REQUEST_TIMEOUT_SEC");
  });

  test("numeric settings must be positive integers", () => {
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_STOP_TIMEOUT_SEC: "0",
      }),
    ).toThrow("EXECUTION_DOCKER_STOP_TIMEOUT_SEC");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_TMPFS_SIZE_MB: "x",
      }),
    ).toThrow("EXECUTION_DOCKER_TMPFS_SIZE_MB");
  });
});
