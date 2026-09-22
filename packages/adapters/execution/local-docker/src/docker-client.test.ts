import { describe, expect, test } from "bun:test";
import {
  DockerClient,
  DockerTimeoutError,
  parseDockerHost,
  parseImageReference,
} from "./docker-client.ts";

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

describe("DockerClient deadlines", () => {
  test("waits out the stop grace, and only the stop", async () => {
    // A daemon that takes longer than the request deadline to answer, the
    // way a stop does while the container drains.
    const daemon = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/stop") || path.endsWith("/version")) {
          await Bun.sleep(150);
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      const client = new DockerClient(
        `tcp://127.0.0.1:${daemon.port}`,
        "v1.43",
        { timeoutMs: 50 },
      );

      await expect(
        client.stopAndRemoveContainer("worker-1", 1),
      ).resolves.toBeUndefined();
      await expect(client.version()).rejects.toBeInstanceOf(DockerTimeoutError);
    } finally {
      daemon.stop(true);
    }
  });
});
