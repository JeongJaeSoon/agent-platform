import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { ObjectIntegrityError } from "@agent-platform/runtime-core";
import { S3Client } from "@aws-sdk/client-s3";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";

/**
 * What this pins down: bytes damaged on the way in fail the SDK's own
 * response checksum before any digest of ours sees them, and the SDK says so
 * with a plain Error. The store turns that into `ObjectIntegrityError`, so a
 * restore can call it damage (94S-345). An SDK that changes how it reports
 * the mismatch fails here rather than in a restore loop.
 */
const BUCKET = "bucket";
const BODY = new TextEncoder().encode("manifest bytes as stored");

describe("checkpoint object store reading a body that fails its checksum", () => {
  let server: Server;
  let endpoint = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, {
        "content-length": String(BODY.byteLength),
        "content-type": "application/octet-stream",
        "x-amz-checksum-crc32": request.url?.includes("/intact")
          ? crc32Of(BODY)
          : crc32Of(new TextEncoder().encode("what the store holds")),
      });
      response.end(BODY);
    });
    endpoint = await listen(server);
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  test("get reports the damage as ObjectIntegrityError", async () => {
    const client = directClient(endpoint);
    const store = createCheckpointObjectStore({ bucket: BUCKET, client });

    const read = store.get("sessions/s/damaged");

    await expect(read).rejects.toBeInstanceOf(ObjectIntegrityError);
    await expect(read).rejects.toMatchObject({ key: "sessions/s/damaged" });
    client.destroy();
  });

  test("stream reports the damage as ObjectIntegrityError", async () => {
    const client = directClient(endpoint);
    const store = createCheckpointObjectStore({ bucket: BUCKET, client });

    const chunks = await store.stream("sessions/s/damaged");
    if (chunks === undefined) throw new Error("expected a body");
    const drained = (async () => {
      for await (const _ of chunks) {
        // drained for the checksum at the end
      }
    })();

    await expect(drained).rejects.toBeInstanceOf(ObjectIntegrityError);
    client.destroy();
  });

  test("a body that matches its checksum reads as usual", async () => {
    const client = directClient(endpoint);
    const store = createCheckpointObjectStore({ bucket: BUCKET, client });

    expect(await store.get("sessions/s/intact")).toEqual(BODY);
    client.destroy();
  });
});

function crc32Of(bytes: Uint8Array): string {
  const value = Buffer.alloc(4);
  value.writeUInt32BE(Bun.hash.crc32(bytes));
  return value.toString("base64");
}

function directClient(endpoint: string): S3Client {
  return new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    region: "ap-northeast-1",
  });
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
