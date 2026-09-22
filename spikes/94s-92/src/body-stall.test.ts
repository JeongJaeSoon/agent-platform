import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { S3SessionStoreProbe } from "./s3-session-store.ts";

/**
 * The flake this pins down: a GetObject settles as soon as the response headers
 * arrive, and the body is a stream consumed afterwards. Nothing in the AWS SDK
 * bounds that read — `requestTimeout` does not reach it and neither does an
 * `abortSignal` passed to `send` — so a peer that stops mid-body leaves
 * `transformToByteArray()` pending forever. In CI that surfaced as
 * `actual-sdk.test.ts` dying at exactly 30000ms with no S3 call in flight.
 */
const BUCKET = "bucket";
const PREFIX = "spike";
const PART = `${PREFIX}/proj/sess/main/part-0000000000001-stalled.jsonl`;

describe("S3SessionStoreProbe against a peer that stalls mid-body", () => {
  let server: Server;
  let endpoint = "";
  let getRequests = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if ((request.url ?? "").includes("list-type=2")) {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(listResponse(PART));
        return;
      }
      getRequests += 1;
      // Headers and a first chunk, then silence: the promised body never ends.
      response.writeHead(200, {
        "content-length": "100",
        "content-type": "application/x-ndjson",
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

  test("gives up on the stalled body instead of hanging the caller", async () => {
    const client = new S3Client({
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
      region: "ap-northeast-1",
    });
    const store = new S3SessionStoreProbe({
      bodyRead: { attempts: 2, timeoutMs: 300 },
      bucket: BUCKET,
      client,
      prefix: PREFIX,
    });

    const startedAt = Date.now();
    const outcome = await Promise.race([
      store.load({ projectKey: "proj", sessionId: "sess" }).then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      Bun.sleep(10_000).then(() => "never settled"),
    ]);
    client.destroy();

    expect(outcome).toContain("stalled 2 times");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // Each attempt is a fresh request: a stalled socket is not reused.
    expect(getRequests).toBe(2);
  }, 20_000);
});

function listResponse(key: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${BUCKET}</Name>
  <Prefix>${PREFIX}/proj/sess/main/</Prefix>
  <KeyCount>1</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>${key}</Key>
    <LastModified>2026-01-01T00:00:00.000Z</LastModified>
    <ETag>&quot;stalled&quot;</ETag>
    <Size>100</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
</ListBucketResult>`;
}
