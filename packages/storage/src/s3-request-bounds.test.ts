import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";
import { createStorageS3Client, type StorageConfig } from "./index.ts";
import {
  DEFAULT_BODY_READ_BOUNDS,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
} from "./s3.ts";

/**
 * The other half of the problem `body-stall.test.ts` pins down: not a peer
 * that stops mid-body but one that never answers at all. The SDK's node
 * handler has no timeout of its own, so such a call never settles and never
 * retries, and every await above it stops.
 *
 * Reads and writes are bounded separately on purpose. A read sends almost
 * nothing, so it fails fast; an upload of a 128 MiB workspace bundle needs
 * minutes on a slow link and must not be cut off for using them.
 */
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("storage S3 client request bounds", () => {
  test("a read gives up on a peer that accepts and never answers", async () => {
    const { accepted, endpoint } = await silentPeer();
    const client = createStorageS3Client(configFor(endpoint));
    const store = createCheckpointObjectStore({
      bodyRead: { ...DEFAULT_BODY_READ_BOUNDS, requestTimeoutMs: 500 },
      bucket: "bucket",
      client,
    });

    const startedAt = Date.now();
    const outcome = await store.get("94s-223/silent-peer").then(
      () => "resolved",
      (error: Error) => error.name,
    );
    client.destroy();

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // Per attempt, not per call: the client retries, and stops.
    expect(accepted.length).toBe(S3_MAX_ATTEMPTS);
  }, 20_000);

  test("the client's own bound ends a call that sends no read timeout", async () => {
    const { endpoint } = await silentPeer();
    const client = createStorageS3Client(configFor(endpoint), {
      ...S3_REQUEST_BOUNDS,
      requestTimeout: 500,
    });

    const startedAt = Date.now();
    let outcome = "never settled";
    try {
      await client.send(
        new PutObjectCommand({
          Body: "body",
          Bucket: "bucket",
          Key: "94s-223/silent-peer",
        }),
      );
      outcome = "resolved";
    } catch (error) {
      outcome = (error as Error).name;
    } finally {
      client.destroy();
    }

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  test("lets a slow but advancing upload finish", async () => {
    // Why the client's bound is measured in minutes: it covers the upload
    // itself. Here the peer drains 64 KiB at a time, so the PUT takes far
    // longer than a read would be given, and it must still land.
    const server = createHttpServer((request, response) => {
      let received = 0;
      request.pause();
      const pump = setInterval(() => {
        const chunk = request.read(64 * 1024) as Buffer | null;
        if (chunk !== null) received += chunk.byteLength;
      }, 100);
      request.on("end", () => {
        clearInterval(pump);
        response.writeHead(200, { etag: `"${received}"` });
        response.end();
      });
    });
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const endpoint = await listen(server);
    const client = createStorageS3Client(configFor(endpoint), {
      ...S3_REQUEST_BOUNDS,
      requestTimeout: 30_000,
    });

    const startedAt = Date.now();
    let outcome = "never settled";
    try {
      await client.send(
        new PutObjectCommand({
          Body: new Uint8Array(2 * 1024 * 1024),
          Bucket: "bucket",
          Key: "94s-223/slow-upload",
        }),
      );
      outcome = "resolved";
    } catch (error) {
      outcome = (error as Error).name;
    } finally {
      client.destroy();
    }

    expect(outcome).toBe("resolved");
    // Slower than a read is ever given, and not punished for it.
    expect(Date.now() - startedAt).toBeGreaterThan(1_000);
  }, 30_000);

  test("keeps the shipped bounds in the shape the SDK needs", () => {
    // @smithy/node-http-handler 4.12.1 logs a warning and keeps waiting when
    // `requestTimeout` expires without this flag, which is indistinguishable
    // from having set no bound at all.
    expect(S3_REQUEST_BOUNDS.throwOnRequestTimeout).toBe(true);
    // 128 MiB at ~437 KiB/s still fits inside the client's bound.
    expect(S3_REQUEST_BOUNDS.requestTimeout).toBeGreaterThanOrEqual(300_000);
    // And a read never waits that long.
    expect(DEFAULT_BODY_READ_BOUNDS.requestTimeoutMs).toBeLessThan(
      S3_REQUEST_BOUNDS.requestTimeout,
    );
  });
});

async function silentPeer(): Promise<{
  accepted: Socket[];
  endpoint: string;
}> {
  const accepted: Socket[] = [];
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.resume();
  });
  closers.push(() => {
    for (const socket of accepted) socket.destroy();
    server.close();
  });
  return { accepted, endpoint: await listen(server) };
}

function configFor(s3Endpoint: string): StorageConfig {
  return {
    bucket: "bucket",
    chunkBytes: 1024,
    git: {
      authorEmail: "test@example.com",
      authorName: "test",
      token: "test",
      username: "test",
    },
    s3: {
      accessKeyId: "test",
      endpoint: s3Endpoint,
      region: "ap-northeast-1",
      secretAccessKey: "test",
    },
  };
}

async function listen(server: Server | ReturnType<typeof createHttpServer>) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test peer did not bind a port");
  }
  return `http://127.0.0.1:${address.port}`;
}
