import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";

import {
  createWorkerObjectStore,
  objectStoreConfigFromEnv,
} from "./object-store.ts";

const base = {
  AWS_ACCESS_KEY_ID: "test",
  AWS_ENDPOINT_URL: "http://localstack:4566",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "not-a-real-secret",
  S3_BUCKET: "claude-sessions",
  WORKER_OBJECT_PREFIX: "sessions/s1/",
};

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("objectStoreConfigFromEnv", () => {
  test("reads the control host's storage variables plus the session prefix", () => {
    expect(objectStoreConfigFromEnv(base)).toEqual({
      accessKeyId: "test",
      bucket: "claude-sessions",
      egress: { noProxy: [] },
      endpoint: "http://localstack:4566",
      region: "ap-northeast-1",
      scope: "sessions/s1/",
      secretAccessKey: "not-a-real-secret",
    });
  });

  test("an https or absent endpoint is accepted, and the proxy is read with it", () => {
    // The egress proxy refuses the GREASE ECH in Bun's own https client
    // (94S-219); the store's https transport sends none (94S-254), so both
    // an https endpoint and AWS itself are reachable again.
    const aws = objectStoreConfigFromEnv({
      ...base,
      AWS_ENDPOINT_URL: undefined,
      HTTPS_PROXY: "http://egress-proxy:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    expect(aws.endpoint).toBeUndefined();
    expect(aws.egress?.proxy?.href).toBe("http://egress-proxy:3128/");
    expect(aws.egress?.noProxy).toEqual(["localhost", "127.0.0.1", "::1"]);
    expect(
      objectStoreConfigFromEnv({ ...base, AWS_ENDPOINT_URL: " " }).endpoint,
    ).toBeUndefined();
    expect(
      objectStoreConfigFromEnv({
        ...base,
        AWS_ENDPOINT_URL: "https://s3.ap-northeast-1.amazonaws.com",
      }).endpoint,
    ).toBe("https://s3.ap-northeast-1.amazonaws.com");
    expect(() =>
      objectStoreConfigFromEnv({
        ...base,
        AWS_ENDPOINT_URL: "ftp://localstack:4566",
      }),
    ).toThrow("http:// or https://");
    // An https store must be named: Bun's TLS cannot verify an address
    // without sending a false server name (TlsTunnelHttpHandler).
    for (const url of ["https://10.0.0.5:9000", "https://[::1]:9000"]) {
      expect(() =>
        objectStoreConfigFromEnv({ ...base, AWS_ENDPOINT_URL: url }),
      ).toThrow("must name its host");
    }
    expect(
      objectStoreConfigFromEnv({
        ...base,
        AWS_ENDPOINT_URL: "http://10.0.0.5:9000",
      }).endpoint,
    ).toBe("http://10.0.0.5:9000");
  });

  test("a credential in the endpoint or the proxy is refused without being quoted", () => {
    for (const url of [
      "https://user:hunter2@s3.example",
      "http://u:hunter2@",
      "ftp://u:hunter2@localstack",
    ]) {
      let message = "";
      try {
        objectStoreConfigFromEnv({ ...base, AWS_ENDPOINT_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("AWS_ENDPOINT_URL");
      expect(message).not.toContain("hunter2");
    }
    for (const proxy of [
      "http://u:hunter2@egress-proxy:3128",
      "http://u:hunter2@",
    ]) {
      let message = "";
      try {
        objectStoreConfigFromEnv({ ...base, HTTPS_PROXY: proxy });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("HTTPS_PROXY");
      expect(message).not.toContain("hunter2");
    }
  });

  test("every variable is required and the prefix must be a key prefix", () => {
    const requiredNames = [
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
      "AWS_SECRET_ACCESS_KEY",
      "S3_BUCKET",
      "WORKER_OBJECT_PREFIX",
    ] as const;
    for (const name of requiredNames) {
      expect(() =>
        objectStoreConfigFromEnv({ ...base, [name]: undefined }),
      ).toThrow(name);
      expect(() => objectStoreConfigFromEnv({ ...base, [name]: " " })).toThrow(
        name,
      );
    }
    for (const prefix of [
      "sessions/s1",
      "/sessions/s1/",
      "sessions/../",
      "sessions/./s1/",
      "sessions//s1/",
      "/",
    ]) {
      expect(() =>
        objectStoreConfigFromEnv({ ...base, WORKER_OBJECT_PREFIX: prefix }),
      ).toThrow("WORKER_OBJECT_PREFIX");
    }
    expect(() =>
      objectStoreConfigFromEnv({ ...base, AWS_ENDPOINT_URL: "localstack" }),
    ).toThrow("AWS_ENDPOINT_URL");
  });
});

describe("createWorkerObjectStore", () => {
  test("refuses a key outside the session prefix without touching the network", async () => {
    const store = createWorkerObjectStore({
      ...objectStoreConfigFromEnv(base),
      // Nothing listens here; a request that got this far would hang or fail
      // with a connection error, not with the scope error asserted below.
      endpoint: "http://127.0.0.1:9",
    });
    await expect(store.get("sessions/s2/x")).rejects.toThrow(
      "outside the scope sessions/s1/",
    );
    await expect(store.list("sessions/")).rejects.toThrow(
      "outside the scope sessions/s1/",
    );
  });

  test("without an endpoint it asks the proxy for a tunnel to the bucket's AWS host", async () => {
    // What the allowlist has to name for AWS: the SDK's virtual-hosted
    // bucket name on 443, never a path-style or plaintext request.
    const { connects, url } = await refusingProxy();
    const store = createWorkerObjectStore(
      objectStoreConfigFromEnv({
        ...base,
        AWS_ENDPOINT_URL: undefined,
        HTTPS_PROXY: url,
      }),
    );
    await expect(store.get("sessions/s1/x")).rejects.toThrow(
      "proxy answered CONNECT",
    );
    expect(connects).toEqual([
      "CONNECT claude-sessions.s3.ap-northeast-1.amazonaws.com:443 HTTP/1.1",
    ]);
  });
});

/** Answers every CONNECT with 403, as the egress proxy does off-allowlist. */
async function refusingProxy(): Promise<{ connects: string[]; url: string }> {
  const connects: string[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      connects.push(head.slice(0, head.indexOf("\r\n")));
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    });
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("proxy did not bind a port");
  }
  return { connects, url: `http://127.0.0.1:${address.port}` };
}
