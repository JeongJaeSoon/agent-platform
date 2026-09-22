import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { GetObjectCommand } from "@aws-sdk/client-s3";

import { createStorageS3Client, type StorageConfig } from "./index.ts";
import { S3_MAX_ATTEMPTS, S3_REQUEST_BOUNDS } from "./s3.ts";

/**
 * The other half of the problem `body-stall.test.ts` pins down: not a peer
 * that stops mid-body but one that never answers at all. The SDK's node
 * handler has no connection or request timeout of its own, so such a call
 * never settles and never retries, and every await above it stops.
 */
describe("storage S3 client request bounds", () => {
  let server: Server;
  let endpoint = "";
  const accepted: Socket[] = [];

  beforeAll(async () => {
    server = createServer((socket) => {
      accepted.push(socket);
      socket.resume();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Silent peer did not bind a port");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    for (const socket of accepted) socket.destroy();
    server.close();
  });

  test("rejects against a peer that accepts and never answers", async () => {
    // Shorter than the shipped values, which are sized for a 128 MiB upload;
    // the shape under test is the same.
    const client = createStorageS3Client(configFor(endpoint), {
      ...S3_REQUEST_BOUNDS,
      connectionTimeout: 500,
      requestTimeout: 500,
    });

    const startedAt = Date.now();
    let outcome = "never settled";
    try {
      await client.send(
        new GetObjectCommand({ Bucket: "bucket", Key: "94s-223/silent-peer" }),
      );
      outcome = "resolved";
    } catch (error) {
      outcome = (error as Error).name;
    } finally {
      client.destroy();
    }

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // The client retries, and stops: the bound is per attempt, not per call.
    expect(accepted.length).toBe(S3_MAX_ATTEMPTS);
  }, 20_000);

  test("throws on the request timeout instead of warning about it", () => {
    // @smithy/node-http-handler 4.12.1 logs a warning and keeps waiting when
    // `requestTimeout` expires without this flag, which is indistinguishable
    // from having set no bound at all.
    expect(S3_REQUEST_BOUNDS.throwOnRequestTimeout).toBe(true);
  });
});

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
