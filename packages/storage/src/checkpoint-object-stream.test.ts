import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  CheckpointObjectStore,
  ImmutableObjectSource,
} from "@agent-platform/runtime-core";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit/checkpoint-objects";
import {
  localstackEnabled,
  withLocalstackBucket,
} from "@agent-platform/testkit/localstack";
import { S3Client } from "@aws-sdk/client-s3";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";
import { type BodyReadBounds, DEFAULT_BODY_READ_BOUNDS } from "./s3.ts";

const KEY = "sessions/s1/checkpoints/0000000000/a/p/workspace.bundle";

/**
 * The `stream` contract, held to by every store: presence is settled before
 * the first chunk, the chunks add up to exactly what was written, a pinned
 * version keeps answering after the key moves on, and a consumer that stops
 * early leaves the store usable.
 */
type Harness = {
  run(use: (store: CheckpointObjectStore) => Promise<void>): Promise<void>;
};

const memory: Harness = {
  run: (use) =>
    use(
      createMemoryCheckpointObjectStore({
        streamChunkBytes: 4096,
        versioned: true,
      }),
    ),
};

const s3: Harness = {
  run: (use) =>
    withLocalstackBucket(
      ({ bucket, s3: client }) =>
        use(createCheckpointObjectStore({ bucket, client })),
      { objectLock: true, prefix: "object-stream-it" },
    ),
};

describe("stream contract: in-memory testkit store", () => {
  streamContract(memory);
});

// Declared either way, so a run without LocalStack reports these as skipped
// rather than never having heard of them.
describe.skipIf(!localstackEnabled())(
  "stream contract: S3 store against LocalStack",
  () => {
    streamContract(s3);
  },
);

function streamContract(harness: Harness) {
  test("an absent key is undefined before any chunk", async () => {
    await harness.run(async (store) => {
      expect(await store.stream(KEY)).toBeUndefined();
    });
  }, 30_000);

  test("delivers exactly the bytes written, copied chunk by chunk", async () => {
    await harness.run(async (store) => {
      // Larger than one chunk of either store, and not a multiple of one.
      const written = new Uint8Array(randomBytes(300 * 1024 + 17));
      await store.put(KEY, written);

      const chunks = await store.stream(KEY);
      expect(chunks).toBeDefined();
      expect(await collect(chunks as AsyncIterable<Uint8Array>)).toEqual(
        written,
      );
    });
  }, 30_000);

  test("a pinned version keeps answering after the key moves on", async () => {
    await harness.run(async (store) => {
      const first = await store.putImmutable(KEY, encode("first\n"));
      expect(first.outcome).toBe("created");
      const version = first.outcome === "created" ? first.version : undefined;
      expect(version).toBeDefined();
      await store.put(KEY, encode("second\n"));

      const pinned = await store.stream(KEY, version);
      const current = await store.stream(KEY);
      expect(decode(await collect(pinned ?? empty()))).toBe("first\n");
      expect(decode(await collect(current ?? empty()))).toBe("second\n");
    });
  }, 30_000);

  test("a streamed putImmutable lands whole, and repeats as duplicate or conflict", async () => {
    await harness.run(async (store) => {
      const written = new Uint8Array(randomBytes(300 * 1024 + 17));
      const other = new Uint8Array(randomBytes(300 * 1024 + 17));

      const created = await store.putImmutable(KEY, streamed(written));
      expect(created.outcome).toBe("created");
      expect(await store.get(KEY)).toEqual(written);
      expect(await store.putImmutable(KEY, streamed(written))).toMatchObject({
        outcome: "duplicate",
      });
      expect(await store.putImmutable(KEY, streamed(other))).toMatchObject({
        outcome: "conflict",
      });
      expect(await store.get(KEY)).toEqual(written);
    });
  }, 30_000);

  test("stopping early leaves the store readable", async () => {
    await harness.run(async (store) => {
      const written = new Uint8Array(randomBytes(256 * 1024));
      await store.put(KEY, written);

      for await (const _chunk of (await store.stream(KEY)) ?? empty()) break;

      expect(await store.get(KEY)).toEqual(written);
    });
  }, 30_000);
}

/**
 * Resuming a stalled read against a peer that records what it was asked. A
 * stall used to be retried from the top, which a stream cannot do once it
 * has handed chunks out; it resumes from the first byte not yet delivered,
 * pinned to the object that answered first.
 */
describe("S3 stream resume", () => {
  const BODY = new Uint8Array(randomBytes(100));
  const ETAG = '"etag-of-the-first-answer"';
  let server: Server | undefined;
  let client: S3Client | undefined;

  afterEach(() => {
    client?.destroy();
    server?.closeAllConnections();
    server?.close();
  });

  async function peer(
    handle: (
      request: IncomingMessage,
      response: ServerResponse,
      index: number,
    ) => void,
  ) {
    const requests: IncomingMessage[] = [];
    server = createServer((request, response) => {
      requests.push(request);
      handle(request, response, requests.length - 1);
    });
    const endpoint = await listen(server);
    client = new S3Client({
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
      endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
      region: "ap-northeast-1",
    });
    return {
      requests,
      store: createCheckpointObjectStore({
        bodyRead: bounds({ attempts: 3, stallMs: 300 }),
        bucket: "bucket",
        client,
      }),
    };
  }

  /** Headers, the first 40 bytes, then silence. */
  function stallAfter40(response: ServerResponse) {
    response.writeHead(200, {
      "content-length": String(BODY.byteLength),
      etag: ETAG,
      "x-amz-version-id": "v1",
    });
    response.write(BODY.subarray(0, 40));
  }

  test("picks up where the stall left off, pinned to the first answer", async () => {
    const { requests, store } = await peer((request, response, index) => {
      if (index === 0) return stallAfter40(response);
      const start = Number(
        /bytes=(\d+)-/.exec(request.headers.range ?? "")?.[1],
      );
      response.writeHead(206, {
        "content-length": String(BODY.byteLength - start),
        "content-range": `bytes ${start}-${BODY.byteLength - 1}/${BODY.byteLength}`,
        etag: ETAG,
        "x-amz-version-id": "v1",
      });
      response.end(BODY.subarray(start));
    });

    const chunks = await store.stream(KEY);
    expect(await collect(chunks ?? empty())).toEqual(BODY);
    expect(requests).toHaveLength(2);
    const resumed = requests[1] as IncomingMessage;
    expect(resumed.headers.range).toBe("bytes=40-");
    expect(resumed.headers["if-match"]).toBe(ETAG);
    // Unversioned read, versioned bucket: the resume asks for the version
    // that answered, not for whatever the key holds by now.
    expect(resumed.url).toContain("versionId=v1");
  }, 10_000);

  test("an object replaced mid-read fails the read instead of splicing", async () => {
    const { store } = await peer((_request, response, index) => {
      if (index === 0) return stallAfter40(response);
      response.writeHead(412, { "content-type": "application/xml" });
      response.end(
        "<Error><Code>PreconditionFailed</Code><Message>no</Message></Error>",
      );
    });

    const chunks = await store.stream(KEY);
    await expect(collect(chunks ?? empty())).rejects.toThrow(
      `S3 object ${KEY} changed while it was being read`,
    );
  }, 10_000);

  test("a peer that ignores the range fails the read instead of repeating bytes", async () => {
    const { store } = await peer((_request, response, index) => {
      if (index === 0) return stallAfter40(response);
      response.writeHead(200, {
        "content-length": String(BODY.byteLength),
        etag: ETAG,
      });
      response.end(BODY);
    });

    const chunks = await store.stream(KEY);
    await expect(collect(chunks ?? empty())).rejects.toThrow(
      "from byte 40 with the whole object",
    );
  }, 10_000);

  test("a resume that covers less than the rest of the object fails the read", async () => {
    const { store } = await peer((_request, response, index) => {
      if (index === 0) return stallAfter40(response);
      response.writeHead(206, {
        "content-length": "10",
        "content-range": `bytes 40-49/${BODY.byteLength}`,
        etag: ETAG,
      });
      response.end(BODY.subarray(40, 50));
    });

    const chunks = await store.stream(KEY);
    await expect(collect(chunks ?? empty())).rejects.toThrow(
      "from byte 40 with bytes 40-49/100",
    );
  }, 10_000);

  test("a body that ends cleanly but short fails the read instead of reaching the digest", async () => {
    // The range header promises the rest; the body stops 30 bytes in.
    const { store } = await peer((_request, response, index) => {
      if (index === 0) return stallAfter40(response);
      response.writeHead(206, {
        "content-length": "30",
        "content-range": `bytes 40-99/${BODY.byteLength}`,
        etag: ETAG,
      });
      response.end(BODY.subarray(40, 70));
    });

    const chunks = await store.stream(KEY);
    await expect(collect(chunks ?? empty())).rejects.toThrow(
      `S3 object ${KEY} ended after 70 of its 100 bytes`,
    );
  }, 10_000);

  test("gives up after the attempts the bounds allow", async () => {
    const { requests, store } = await peer((request, response) => {
      const start = Number(
        /bytes=(\d+)-/.exec(request.headers.range ?? "")?.[1] ?? 0,
      );
      // Every answer delivers one more byte and stalls again.
      response.writeHead(start === 0 ? 200 : 206, {
        "content-length": String(BODY.byteLength - start),
        ...(start === 0
          ? {}
          : {
              "content-range": `bytes ${start}-${BODY.byteLength - 1}/${BODY.byteLength}`,
            }),
        etag: ETAG,
      });
      response.write(BODY.subarray(start, start + 1));
    });

    const chunks = await store.stream(KEY);
    await expect(collect(chunks ?? empty())).rejects.toThrow(
      `S3 object body stalled 3 times: ${KEY}`,
    );
    expect(requests).toHaveLength(3);
  }, 10_000);

  test("a consumer that stops early closes the connection", async () => {
    let closed = false;
    const { store } = await peer((_request, response) =>
      stallAfter40(response),
    );
    // The socket, not the response: bun's server does not report a client
    // that went away mid-response on the response itself.
    server?.on("connection", (socket) =>
      socket.on("close", () => {
        closed = true;
      }),
    );

    for await (const _chunk of (await store.stream(KEY)) ?? empty()) break;

    const deadline = Date.now() + 2_000;
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(closed).toBe(true);
  }, 10_000);
});

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  // Copies: a chunk is only valid until the next one is asked for.
  for await (const chunk of chunks) parts.push(chunk.slice());
  return new Uint8Array(Buffer.concat(parts));
}

async function* empty(): AsyncGenerator<Uint8Array> {}

/** `bytes` as a streamed body, in refilled 64 KiB chunks. */
function streamed(bytes: Uint8Array): ImmutableObjectSource {
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    async *open() {
      const buffer = new Uint8Array(64 * 1024);
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        const piece = bytes.subarray(offset, offset + 64 * 1024);
        buffer.set(piece);
        yield buffer.subarray(0, piece.byteLength);
      }
    },
  };
}

function bounds(overrides: Partial<BodyReadBounds> = {}): BodyReadBounds {
  return { ...DEFAULT_BODY_READ_BOUNDS, ...overrides };
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test peer did not bind a port");
  }
  return `http://127.0.0.1:${address.port}`;
}
