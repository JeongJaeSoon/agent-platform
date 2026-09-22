import { describe, expect, test } from "bun:test";
import { parseDockerHost, parseImageReference } from "./docker-client.ts";

describe("parseImageReference", () => {
  test("keeps registry ports in the name and reads tags or digests", () => {
    expect(parseImageReference("busybox:1.36")).toEqual({
      name: "busybox",
      tag: "1.36",
    });
    expect(parseImageReference("busybox")).toEqual({
      name: "busybox",
      tag: "latest",
    });
    expect(parseImageReference("localhost:5000/org/worker:tag")).toEqual({
      name: "localhost:5000/org/worker",
      tag: "tag",
    });
    expect(parseImageReference("localhost:5000/org/worker")).toEqual({
      name: "localhost:5000/org/worker",
      tag: "latest",
    });
    expect(parseImageReference("ghcr.io/org/worker@sha256:abc")).toEqual({
      name: "ghcr.io/org/worker",
      tag: "sha256:abc",
    });
  });
});

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
