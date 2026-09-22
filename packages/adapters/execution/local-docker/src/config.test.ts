import { describe, expect, test } from "bun:test";
import { localDockerConfigFromEnv } from "./config.ts";

const base = { WORKER_GATEWAY_URL: "http://host.docker.internal:3000" };

describe("localDockerConfigFromEnv", () => {
  test("applies the documented defaults", () => {
    expect(localDockerConfigFromEnv(base)).toEqual({
      allowedNetworks: ["bridge"],
      apiVersion: "v1.44",
      dockerHost: "unix:///var/run/docker.sock",
      gatewayUrl: "http://host.docker.internal:3000",
      homeDir: "/home/worker",
      installationId: "local",
      network: "bridge",
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
      localDockerConfigFromEnv({ WORKER_GATEWAY_URL: "not a url" }),
    ).toThrow("WORKER_GATEWAY_URL");
  });

  test("the network must be on the allowlist and never host", () => {
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
        EXECUTION_DOCKER_NETWORK_ALLOWLIST: "bridge, ap-workers",
      }),
    ).toMatchObject({
      allowedNetworks: ["bridge", "ap-workers"],
      network: "ap-workers",
    });
    expect(() =>
      localDockerConfigFromEnv({
        ...base,
        EXECUTION_DOCKER_NETWORK: "host",
        EXECUTION_DOCKER_NETWORK_ALLOWLIST: "host",
      }),
    ).toThrow("host");
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
