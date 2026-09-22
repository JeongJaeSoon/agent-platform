import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createLocalstackClient } from "./localstack.ts";

/**
 * The failure this pins down is not a slow peer but a silent one: a peer that
 * completes the TCP handshake, reads the request and never answers. The AWS
 * SDK's default node handler has no request or connection timeout, so such a
 * call never settles and never retries, and every await above it stops. In CI
 * that surfaced only as `timed out after 30000ms` in `actual-sdk.test.ts`.
 */
describe("LocalStack S3 client request bounds", () => {
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
      throw new Error("Stalled peer did not bind a port");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    for (const socket of accepted) socket.destroy();
    server.close();
  });

  test("rejects against a peer that accepts and never answers", async () => {
    const previous = process.env.AWS_ENDPOINT_URL;
    process.env.AWS_ENDPOINT_URL = endpoint;
    const client = createLocalstackClient();
    process.env.AWS_ENDPOINT_URL = previous;

    const startedAt = Date.now();
    let outcome = "never settled";
    try {
      await client.send(
        new PutObjectCommand({
          Body: "body",
          Bucket: "bucket",
          Key: "94s-217/stalled-peer",
        }),
      );
      outcome = "resolved";
    } catch (error) {
      outcome = (error as Error).name;
    } finally {
      client.destroy();
    }

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  }, 25_000);
});
