import { describe, expect, test } from "bun:test";
import { parseDockerHost } from "./docker-client.ts";

describe("parseDockerHost", () => {
  test("accepts the DOCKER_HOST spellings", () => {
    expect(parseDockerHost("unix:///var/run/docker.sock")).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
    expect(parseDockerHost("tcp://127.0.0.1:2375")).toEqual({
      baseUrl: "http://127.0.0.1:2375",
      kind: "http",
    });
    expect(parseDockerHost("https://docker.internal:2376")).toEqual({
      baseUrl: "https://docker.internal:2376",
      kind: "http",
    });
  });

  test("rejects unknown schemes and an empty socket path", () => {
    expect(() => parseDockerHost("unix://")).toThrow("socket path");
    expect(() => parseDockerHost("/var/run/docker.sock")).toThrow("unix://");
  });
});
