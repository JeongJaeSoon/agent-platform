import { describe, expect, test } from "bun:test";
import { localDockerConfigFromEnv } from "./config.ts";

const base = {
  AWS_ACCESS_KEY_ID: "test",
  AWS_ENDPOINT_URL: "http://localstack:4566",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "test",
  EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
  S3_BUCKET: "claude-sessions",
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
      objectStore: {
        accessKeyId: "test",
        bucket: "claude-sessions",
        endpoint: "http://localstack:4566",
        region: "ap-northeast-1",
        secretAccessKey: "test",
      },
      requestTimeoutMs: 30_000,
      stopTimeoutSeconds: 10,
      tmpfsSizeBytes: 256 * 1024 * 1024,
      user: "1000:1000",
      workspaceDir: "/workspace",
    });
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

  test("object store access is required and the endpoint optional", () => {
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
      "AWS_SECRET_ACCESS_KEY",
      "S3_BUCKET",
    ] as const) {
      expect(() =>
        localDockerConfigFromEnv({ ...base, [name]: undefined }),
      ).toThrow(name);
      expect(() => localDockerConfigFromEnv({ ...base, [name]: " " })).toThrow(
        name,
      );
    }
    const aws = localDockerConfigFromEnv({ ...base, AWS_ENDPOINT_URL: "" });
    expect("endpoint" in aws.objectStore).toBe(false);
    expect(() =>
      localDockerConfigFromEnv({ ...base, AWS_ENDPOINT_URL: "localstack" }),
    ).toThrow("AWS_ENDPOINT_URL");
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        AWS_ENDPOINT_URL: "ftp://localstack:4566",
      }),
    ).toThrow("http(s)://");
    let message = "";
    try {
      localDockerConfigFromEnv({
        ...base,
        AWS_ENDPOINT_URL: "http://user:hunter2@localstack:4566",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("credentials");
    expect(message).not.toContain("hunter2");
  });

  test("a refused object store value is named, never quoted", () => {
    // These land in scheduler logs; the check is by name so the message
    // can be logged as is. The key id is the one that could be quoted
    // harmlessly, and it is still not.
    for (const [name, value] of [
      ["AWS_SECRET_ACCESS_KEY", "sk with space"],
      ["AWS_ACCESS_KEY_ID", "AKIA=oops"],
      ["S3_BUCKET", "my bucket"],
    ] as const) {
      let message = "";
      try {
        localDockerConfigFromEnv({ ...base, [name]: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(value);
    }
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
