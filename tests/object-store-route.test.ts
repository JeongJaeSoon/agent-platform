import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  type CredentialProxyServer,
  startCredentialProxy,
} from "@agent-platform/egress-proxy/src/credential.ts";
import {
  createLocalstackBucket,
  type LocalstackBucket,
  localstackEnabled,
  localstackEnv,
} from "@agent-platform/testkit/localstack";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  createWorkerObjectStore,
  objectStoreConfigFromEnv,
} from "../apps/worker/src/object-store.ts";
import {
  type ObjectRouteFixture,
  startObjectRouteFixture,
} from "./object-route-fixture.ts";

/**
 * The worker's only way to the object store (94S-251): the egress proxy's
 * object store route, the real authorizer behind it and the real signer,
 * with the worker holding nothing but its attempt's token. A raw S3 client
 * with that token as its key — what a worker that ignores its own wrapper
 * would send — reaches its own session's prefix and nothing else, and the
 * token stops working once the next generation claims.
 *
 * The first half runs against a recording stand-in for S3, so what reaches
 * the upstream is visible; the second against LocalStack, so the signature
 * is checked by something that is not this code.
 */

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

type Seen = { method: string; target: string; headers: Headers };

async function withProxy(
  fixture: ObjectRouteFixture,
  upstream: URL,
): Promise<CredentialProxyServer> {
  return startCredentialProxy({
    authorizer: { url: fixture.authorizerUrl, token: fixture.authorizerToken },
    hostname: "127.0.0.1",
    logger: quiet,
    policy: {
      allow: [],
      allowPrivate: [
        { host: upstream.hostname, port: Number(upstream.port || 80) },
      ],
    },
    port: 0,
  });
}

function rawClient(proxy: CredentialProxyServer, token: string): S3Client {
  return new S3Client({
    credentials: { accessKeyId: token, secretAccessKey: "anything" },
    endpoint: `http://127.0.0.1:${proxy.port}/object-store`,
    forcePathStyle: true,
    maxAttempts: 1,
    region: "ap-northeast-1",
  });
}

function workerStore(
  proxy: CredentialProxyServer,
  bucket: string,
  sessionId: string,
  token: () => string,
) {
  return createWorkerObjectStore(
    objectStoreConfigFromEnv(
      {
        AWS_REGION: "ap-northeast-1",
        S3_BUCKET: bucket,
        WORKER_OBJECT_PREFIX: `sessions/${sessionId}/`,
      },
      `http://127.0.0.1:${proxy.port}`,
    ),
    token,
  );
}

async function refusal(send: Promise<unknown>): Promise<string> {
  try {
    await send;
  } catch (error) {
    if (error instanceof S3ServiceException) return error.name;
    throw error;
  }
  throw new Error("the request went through");
}

/** Every operation a worker could aim at a key or prefix it does not own. */
function escapes(bucket: string, own: string, foreign: string) {
  return [
    [
      "get another session's object",
      new GetObjectCommand({ Bucket: bucket, Key: `${foreign}x` }),
    ],
    [
      "put into another session",
      new PutObjectCommand({ Body: "x", Bucket: bucket, Key: `${foreign}x` }),
    ],
    [
      "list another session",
      new ListObjectsV2Command({ Bucket: bucket, Prefix: foreign }),
    ],
    [
      "list every session",
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "sessions/" }),
    ],
    [
      "delete another session's object",
      new DeleteObjectCommand({ Bucket: bucket, Key: `${foreign}x` }),
    ],
    [
      "delete its own object",
      new DeleteObjectCommand({ Bucket: bucket, Key: `${own}x` }),
    ],
    [
      "delete one of its own versions",
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: `${own}x`,
        VersionId: "v1",
      }),
    ],
    [
      "place or release a legal hold",
      new PutObjectLegalHoldCommand({
        Bucket: bucket,
        Key: `${own}x`,
        LegalHold: { Status: "OFF" },
      }),
    ],
    [
      "set a retention",
      new PutObjectRetentionCommand({
        Bucket: bucket,
        BypassGovernanceRetention: true,
        Key: `${own}x`,
        Retention: { Mode: "GOVERNANCE", RetainUntilDate: new Date(0) },
      }),
    ],
    [
      "copy another session's object into its own",
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${foreign}x`,
        Key: `${own}copy`,
      }),
    ],
    [
      "list versions of its own prefix",
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: own }),
    ],
  ] as const;
}

describe("the object store route, against a recording S3", () => {
  const BUCKET = "claude-sessions";
  const seen: Seen[] = [];
  const objects = new Map<string, Uint8Array>();
  let s3: ReturnType<typeof Bun.serve>;
  let fixture: ObjectRouteFixture;
  let proxy: CredentialProxyServer;

  beforeAll(async () => {
    s3 = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push({
          method: request.method,
          target: `${url.pathname}${url.search}`,
          headers: request.headers,
        });
        const key = decodeURIComponent(url.pathname);
        if (request.method === "PUT") {
          objects.set(key, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { headers: { etag: '"e"' } });
        }
        const found = objects.get(key);
        if (found === undefined) {
          return new Response(
            "<Error><Code>NoSuchKey</Code><Message>none</Message></Error>",
            { status: 404, headers: { "content-type": "application/xml" } },
          );
        }
        return new Response(found);
      },
    });
    fixture = await startObjectRouteFixture({
      objectStore: {
        accessKeyId: "AKIDCONTROLHOST",
        bucket: BUCKET,
        endpoint: `http://127.0.0.1:${s3.port}`,
        region: "ap-northeast-1",
        secretAccessKey: "control-host-secret",
      },
    });
    proxy = await withProxy(fixture, new URL(`http://127.0.0.1:${s3.port}`));
  });

  afterAll(async () => {
    proxy?.stop();
    await fixture?.stop();
    s3?.stop(true);
  });

  afterEach(() => {
    seen.length = 0;
  });

  test("the worker's store writes and reads its prefix, signed with the control host's key", async () => {
    const session = await fixture.openSession();
    const token = await session.claim();
    const store = workerStore(proxy, BUCKET, session.sessionId, () => token);
    const own = `sessions/${session.sessionId}/`;
    // Past the SDK's 100-continue threshold, so that path is exercised too.
    const body = new Uint8Array(3 * 1024 * 1024).fill(7);
    expect(await store.putImmutable(`${own}bundle`, body)).toEqual({
      outcome: "created",
    });
    expect(await store.get(`${own}bundle`)).toEqual(body);

    const put = seen.find((entry) => entry.method === "PUT");
    expect(put?.target).toBe(`/${BUCKET}/${own}bundle`);
    expect(put?.headers.get("if-none-match")).toBe("*");
    expect(put?.headers.get("authorization")).toContain(
      "Credential=AKIDCONTROLHOST/",
    );
    for (const entry of seen) {
      for (const [, value] of entry.headers) {
        expect(value).not.toContain(token);
      }
    }
  });

  test("a raw client with the token reaches nothing outside its own prefix", async () => {
    const session = await fixture.openSession();
    const token = await session.claim();
    const client = rawClient(proxy, token);
    const own = `sessions/${session.sessionId}/`;
    const foreign = "sessions/another-session/";
    objects.set(`/${BUCKET}/${foreign}x`, new TextEncoder().encode("theirs"));
    // The same client, same shape of request, is allowed at home: the
    // refusals below are about where, not how.
    await client.send(
      new PutObjectCommand({ Body: "mine", Bucket: BUCKET, Key: `${own}x` }),
    );
    seen.length = 0;
    for (const [what, command] of escapes(BUCKET, own, foreign)) {
      // biome-ignore lint/suspicious/noExplicitAny: one client, many commands
      const name = await refusal(client.send(command as any));
      expect(`${what}: ${name}`).toBe(`${what}: AccessDenied`);
    }
    expect(seen).toEqual([]);
    expect(
      new TextDecoder().decode(objects.get(`/${BUCKET}/${foreign}x`)),
    ).toBe("theirs");
  });

  test("a token nobody issued is not a key", async () => {
    const session = await fixture.openSession();
    const client = rawClient(proxy, "weo_forged");
    const name = await refusal(
      client.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: `sessions/${session.sessionId}/x`,
        }),
      ),
    );
    expect(name).toBe("InvalidAccessKeyId");
    expect(seen).toEqual([]);
  });

  test("once the next generation claims, the previous token writes nothing", async () => {
    const session = await fixture.openSession();
    const earlier = await session.claim();
    const later = await session.claim();
    const key = `sessions/${session.sessionId}/after-takeover`;
    const name = await refusal(
      rawClient(proxy, earlier).send(
        new PutObjectCommand({ Body: "late", Bucket: BUCKET, Key: key }),
      ),
    );
    expect(["AccessDenied", "InvalidAccessKeyId"]).toContain(name);
    expect(seen).toEqual([]);
    expect(objects.has(`/${BUCKET}/${key}`)).toBe(false);

    await rawClient(proxy, later).send(
      new PutObjectCommand({ Body: "live", Bucket: BUCKET, Key: key }),
    );
    expect(new TextDecoder().decode(objects.get(`/${BUCKET}/${key}`))).toBe(
      "live",
    );
  });
});

describe.skipIf(!localstackEnabled())(
  "the object store route, against LocalStack",
  () => {
    let bucket: LocalstackBucket;
    let fixture: ObjectRouteFixture;
    let proxy: CredentialProxyServer;

    beforeAll(async () => {
      const env = localstackEnv();
      bucket = await createLocalstackBucket({
        objectLock: true,
        prefix: "object-route",
      });
      fixture = await startObjectRouteFixture({
        objectStore: { ...env, bucket: bucket.bucket },
      });
      proxy = await withProxy(fixture, new URL(env.endpoint));
    });

    afterAll(async () => {
      proxy?.stop();
      await fixture?.stop();
      await bucket?.destroy();
    });

    test("the worker's store does everything a checkpoint needs", async () => {
      const session = await fixture.openSession();
      const token = await session.claim();
      const store = workerStore(
        proxy,
        bucket.bucket,
        session.sessionId,
        () => token,
      );
      const own = `sessions/${session.sessionId}/`;
      const body = new TextEncoder().encode("manifest");
      const created = await store.putImmutable(`${own}m.json`, body);
      expect(created.outcome).toBe("created");
      expect((await store.putImmutable(`${own}m.json`, body)).outcome).toBe(
        "duplicate",
      );
      expect(
        (
          await store.putImmutable(
            `${own}m.json`,
            new TextEncoder().encode("x"),
          )
        ).outcome,
      ).toBe("conflict");
      await store.put(`${own}transcript/part-0`, new TextEncoder().encode("t"));
      expect(await store.get(`${own}m.json`)).toEqual(body);
      if (created.outcome !== "created" || created.version === undefined) {
        throw new Error("a locked bucket reports versions");
      }
      expect(await store.get(`${own}m.json`, created.version)).toEqual(body);
      expect(await store.head(`${own}m.json`)).toMatchObject({ bytes: 8 });
      expect((await store.list(own)).sort()).toEqual([
        `${own}m.json`,
        `${own}transcript/part-0`,
      ]);
    });

    test("a raw client with the token reaches nothing outside its own prefix", async () => {
      const session = await fixture.openSession();
      const token = await session.claim();
      const client = rawClient(proxy, token);
      const own = `sessions/${session.sessionId}/`;
      const foreign = "sessions/another-session/";
      await bucket.s3.send(
        new PutObjectCommand({
          Body: "theirs",
          Bucket: bucket.bucket,
          Key: `${foreign}x`,
        }),
      );
      await client.send(
        new PutObjectCommand({
          Body: "mine",
          Bucket: bucket.bucket,
          Key: `${own}x`,
        }),
      );
      for (const [what, command] of escapes(bucket.bucket, own, foreign)) {
        // biome-ignore lint/suspicious/noExplicitAny: one client, many commands
        const name = await refusal(client.send(command as any));
        expect(`${what}: ${name}`).toBe(`${what}: AccessDenied`);
      }
      const theirs = await bucket.s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket.bucket,
          Prefix: foreign,
        }),
      );
      expect(theirs.Versions?.map((version) => version.Key)).toEqual([
        `${foreign}x`,
      ]);
      const mine = await bucket.s3.send(
        new GetObjectCommand({ Bucket: bucket.bucket, Key: `${own}x` }),
      );
      expect(await mine.Body?.transformToString()).toBe("mine");
    });

    test("once the next generation claims, the previous token writes nothing", async () => {
      const session = await fixture.openSession();
      const earlier = await session.claim();
      await session.claim();
      const key = `sessions/${session.sessionId}/after-takeover`;
      const name = await refusal(
        rawClient(proxy, earlier).send(
          new PutObjectCommand({
            Body: "late",
            Bucket: bucket.bucket,
            Key: key,
          }),
        ),
      );
      expect(["AccessDenied", "InvalidAccessKeyId"]).toContain(name);
      const listed = await bucket.s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket.bucket, Prefix: key }),
      );
      expect(listed.Versions ?? []).toEqual([]);
    });
  },
);
