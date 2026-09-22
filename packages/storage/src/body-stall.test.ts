import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";
import { bodyBytes, type S3ClientLike } from "./s3.ts";

/**
 * What this pins down: a GetObject settles as soon as the response headers
 * arrive, and the body is a stream consumed afterwards. Nothing in the AWS SDK
 * bounds that read — `requestTimeout` does not reach it and neither does an
 * `abortSignal` passed to `send` — so a peer that stops mid-body leaves the
 * read pending forever. Remove the bound in `bodyBytes()` and every test here
 * stops failing and starts hanging.
 */
const BUCKET = "bucket";
const KEY = "checkpoints/sess/stalled";

describe("checkpoint object store against a peer that stalls mid-body", () => {
  let server: Server;
  let endpoint = "";
  let getRequests = 0;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      getRequests += 1;
      // Headers and a first chunk, then silence: the promised body never ends.
      response.writeHead(200, {
        "content-length": "100",
        "content-type": "application/octet-stream",
      });
      response.write("0123456789");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Stalling peer did not bind a port");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  test("gives up on the stalled body and retries on a fresh request", async () => {
    const client = new S3Client({
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
      region: "ap-northeast-1",
    });
    const store = createCheckpointObjectStore({
      bodyRead: { attempts: 2, stallMs: 300 },
      bucket: BUCKET,
      client,
    });

    const startedAt = Date.now();
    const outcome = await store.get(KEY).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    client.destroy();

    expect(outcome).toContain("stalled 2 times");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    // Each attempt is a fresh request: the stalled socket was destroyed, not
    // handed back to the pool for the retry to queue behind.
    expect(getRequests).toBe(2);
  }, 10_000);
});

describe("bodyBytes bounds", () => {
  test("bounds a body that only offers transformToByteArray", async () => {
    let destroyed: Error | undefined;
    const body = {
      destroy: (cause?: Error) => {
        destroyed = cause;
      },
      transformToByteArray: () => new Promise<Uint8Array>(() => undefined),
    };

    const startedAt = Date.now();
    await expect(bodyBytes(body, 200)).rejects.toThrow(
      "delivered nothing for 200ms",
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(destroyed?.name).toBe("BodyStallError");
  }, 10_000);

  test("still rejects when letting go of the socket throws", async () => {
    const body = {
      destroy: () => {
        throw new Error("the socket was already gone");
      },
      transformToByteArray: () => new Promise<Uint8Array>(() => undefined),
    };

    await expect(bodyBytes(body, 200)).rejects.toThrow(
      "delivered nothing for 200ms",
    );
  }, 10_000);

  test("closes an async iterable that has no destroy", async () => {
    let closed = false;
    const body = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };

    await expect(bodyBytes(body, 200)).rejects.toThrow(
      "delivered nothing for 200ms",
    );
    expect(closed).toBe(true);
  }, 10_000);

  test("reads a body that offers both shapes through its stream", async () => {
    const body = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("first ");
        yield "second";
      },
      transformToByteArray: () => {
        throw new Error("the stream carries the progress signal, not this");
      },
    };

    expect(new TextDecoder().decode(await bodyBytes(body, 1_000))).toBe(
      "first second",
    );
  });

  test("retries a stalled read and gives up with the key in the message", async () => {
    let sends = 0;
    const client: S3ClientLike = {
      async send() {
        sends += 1;
        return {
          Body: { transformToByteArray: () => new Promise(() => undefined) },
        };
      },
    };
    const store = createCheckpointObjectStore({
      bodyRead: { attempts: 3, stallMs: 100 },
      bucket: BUCKET,
      client,
    });

    await expect(store.get(KEY)).rejects.toThrow(
      `S3 object body stalled 3 times: ${KEY}`,
    );
    expect(sends).toBe(3);
  }, 10_000);
});
