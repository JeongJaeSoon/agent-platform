import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createNetServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { HttpRequest } from "@smithy/core/protocols";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";
import { createStorageS3Client } from "./index.ts";
import {
  DEFAULT_BODY_READ_BOUNDS,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  type S3RequestBounds,
} from "./s3.ts";
import {
  bypassesProxy,
  type EgressRoute,
  egressRouteFromEnv,
  TlsTunnelHttpHandler,
} from "./tls-tunnel-handler.ts";

/**
 * The https transport the worker uses behind the egress proxy (94S-254),
 * held to what `BoundedNodeHttpHandler` guarantees: certificate and name
 * verification, the request-stage bounds and the body idle bound of 94S-223,
 * cancellation and streaming. Every peer here is a raw TLS server, so the
 * bytes on the wire are exactly the ones a case needs, and every request
 * goes through a real CONNECT tunnel unless a case says otherwise.
 */

type Certificate = { cert: string; key: string };
let directory = "";
/** Names `localhost` only. */
let named: Certificate;
/** Names `other.test` only: a certificate for somebody else. */
let other: Certificate;
const closers: Array<() => void> = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tls-tunnel-"));
  named = await mintCertificate("localhost", "DNS:localhost");
  other = await mintCertificate("other.test", "DNS:other.test");
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("TlsTunnelHttpHandler through a CONNECT proxy", () => {
  test("carries a checkpoint store's PUT, GET, HEAD and LIST, naming the endpoint in CONNECT and SNI", async () => {
    const peer = await fakeS3();
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy));
    const store = createCheckpointObjectStore({ bucket: "bucket", client });
    const big = new Uint8Array(8 * 1024 * 1024).map((_, i) => i % 251);

    expect(await store.putImmutable("s/1/manifest.json", encode("{}"))).toEqual(
      { outcome: "created" },
    );
    // The conditional PUT reaches the peer as signed, and its 412 comes back
    // as the SDK's own error, read back as a duplicate.
    expect(await store.putImmutable("s/1/manifest.json", encode("{}"))).toEqual(
      { outcome: "duplicate" },
    );
    await store.put("s/1/part-0", big);
    expect(await store.get("s/1/part-0")).toEqual(big);
    expect(await store.head("s/1/part-0")).toEqual({ bytes: big.byteLength });
    expect(await store.head("s/1/absent")).toBeUndefined();
    expect(await store.get("s/1/absent")).toBeUndefined();
    // The fake sends list pages chunked, with an extension and a trailer.
    expect(await store.list("s/1/")).toEqual([
      "s/1/manifest.json",
      "s/1/part-0",
    ]);
    client.destroy();

    expect(new Set(proxy.connects)).toEqual(
      new Set([`CONNECT localhost:${peer.port} HTTP/1.1`]),
    );
    expect(new Set(peer.servernames)).toEqual(new Set(["localhost"]));
    for (const head of peer.heads) {
      expect(head).toContain("\r\nconnection: close");
      expect(head.toLowerCase()).not.toContain("expect:");
    }
    // One request per connection, and none of them left open.
    expect(peer.connections).toBe(peer.heads.length);
    await until(() => peer.open() === 0);
  }, 30_000);

  test("an IP-literal endpoint is refused before anything is dialled", async () => {
    // Bun's node:tls either sends SNI "localhost" and verifies for it, or
    // sends the address as SNI; there is no safe way to talk to an address.
    const proxy = await tunnellingProxy();
    const client = clientFor(1, routeVia(proxy), "127.0.0.1");
    const error = await client
      .send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }))
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    client.destroy();

    expect(error?.message).toContain("must be a DNS name");
    expect(proxy.connects).toEqual([]);
  }, 20_000);

  test("a host in NO_PROXY is dialled directly", async () => {
    const peer = await fakeS3();
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, {
      ...routeVia(proxy),
      noProxy: ["localhost"],
    });
    const store = createCheckpointObjectStore({ bucket: "bucket", client });

    await store.put("k", encode("v"));
    client.destroy();

    expect(proxy.connects).toEqual([]);
    expect(peer.heads).toHaveLength(1);
  }, 20_000);

  test("an untrusted certificate is refused before a request is sent, and not retried", async () => {
    const peer = await fakeS3();
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, {
      noProxy: [],
      proxy: proxyUrl(proxy),
    });

    const error = await client
      .send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }))
      .then(
        () => undefined,
        (caught: Error & { code?: string }) => caught,
      );
    client.destroy();

    expect(error?.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);
    expect(peer.heads).toEqual([]);
    expect(proxy.connects).toHaveLength(1);
  }, 20_000);

  test("a certificate for another name is refused", async () => {
    // Trusted, but issued to other.test while the endpoint is localhost.
    const peer = await fakeS3({ certificate: other });
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy, other));

    const error = await client
      .send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }))
      .then(
        () => undefined,
        (caught: Error & { code?: string }) => caught,
      );
    client.destroy();

    expect(error?.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(peer.heads).toEqual([]);
  }, 20_000);

  test("a refusal the proxy decided is final; one it could not carry out is retried", async () => {
    for (const [status, attempts] of [
      [403, 1],
      [502, S3_MAX_ATTEMPTS],
    ] as const) {
      const proxy = await tunnellingProxy({ refuse: status });
      const client = clientFor(1, routeVia(proxy));
      const error = await client
        .send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }))
        .then(
          () => undefined,
          (caught: Error) => caught,
        );
      client.destroy();

      expect(error?.name).toBe("ProxyConnectError");
      expect(error?.message).toContain(`${status}`);
      expect(proxy.connects).toHaveLength(attempts);
    }
  }, 30_000);
});

/**
 * The same cases as `s3-request-bounds.test.ts` and `body-stall.test.ts`,
 * run against this transport: a bound the node handler keeps and this one
 * dropped would be a hang in production and nowhere else.
 */
describe("TlsTunnelHttpHandler request and body bounds", () => {
  test("a read gives up on a peer that completes the handshake and never answers", async () => {
    const peer = await tlsPeer(() => undefined);
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy));
    const store = createCheckpointObjectStore({
      bodyRead: { ...DEFAULT_BODY_READ_BOUNDS, requestTimeoutMs: 500 },
      bucket: "bucket",
      client,
    });

    const startedAt = Date.now();
    const outcome = await store.get("silent").then(
      () => "resolved",
      (error: Error) => error.name,
    );
    client.destroy();

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(peer.heads).toHaveLength(S3_MAX_ATTEMPTS);
  }, 20_000);

  test("the client's own bound ends a call that sends no read timeout", async () => {
    const peer = await tlsPeer(() => undefined);
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy), "localhost", {
      ...S3_REQUEST_BOUNDS,
      requestTimeout: 500,
    });

    const startedAt = Date.now();
    const outcome = await client
      .send(new PutObjectCommand({ Body: "body", Bucket: "bucket", Key: "k" }))
      .then(
        () => "resolved",
        (error: Error) => error.name,
      );
    client.destroy();

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  test("the connection bound covers the handshake, not only the dial", async () => {
    // Accepts TCP, never says a word of TLS: the tunnel is up and the
    // handshake is what hangs.
    const mute = await plainListener();
    const proxy = await tunnellingProxy();
    const client = clientFor(mute.port, routeVia(proxy), "localhost", {
      ...S3_REQUEST_BOUNDS,
      connectionTimeout: 300,
    });

    const startedAt = Date.now();
    const error = await client
      .send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }))
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    client.destroy();

    expect(error?.name).toBe("TimeoutError");
    expect(error?.message).toContain("not established within 300ms");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(mute.accepted()).toBe(S3_MAX_ATTEMPTS);
  }, 20_000);

  test("the connection bound covers a proxy that never answers CONNECT", async () => {
    const mute = await plainListener();
    const client = clientFor(
      1,
      {
        ca: named.cert,
        noProxy: [],
        proxy: new URL(`http://127.0.0.1:${mute.port}`),
      },
      "localhost",
      {
        ...S3_REQUEST_BOUNDS,
        connectionTimeout: 300,
      },
    );

    const error = await client
      .send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }))
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    client.destroy();

    expect(error?.name).toBe("TimeoutError");
  }, 20_000);

  test("lets an upload whose answer is slow finish", async () => {
    // Bun's TLS server takes the whole body at once however it is read, so
    // the slowness is the peer's answer instead: nothing but the client's
    // own bound may cut a PUT short.
    const peer = await tlsPeer((socket, request) => {
      setTimeout(() => {
        socket.write(
          `HTTP/1.1 200 OK\r\netag: "${request.body.byteLength}"\r\ncontent-length: 0\r\n\r\n`,
        );
      }, 1_500);
    });
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy), "localhost", {
      ...S3_REQUEST_BOUNDS,
      requestTimeout: 30_000,
    });

    const startedAt = Date.now();
    const outcome = await client
      .send(
        new PutObjectCommand({
          Body: new Uint8Array(2 * 1024 * 1024),
          Bucket: "bucket",
          Key: "slow",
        }),
      )
      .then(
        () => "resolved",
        (error: Error) => error.message,
      );
    client.destroy();

    expect(outcome).toBe("resolved");
    expect(Date.now() - startedAt).toBeGreaterThan(1_000);
  }, 30_000);

  test("gives up on an error body that stops mid-XML", async () => {
    const peer = await tlsPeer(stallingXml(503));
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy), "localhost", {
      ...S3_REQUEST_BOUNDS,
      bodyIdleMs: 300,
    });
    const store = createCheckpointObjectStore({ bucket: "bucket", client });

    const startedAt = Date.now();
    const outcome = await store.get("stalled-error").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    client.destroy();

    expect(outcome).toContain("stalled 3 times");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 20_000);

  test("gives up on a list page that stops mid-XML", async () => {
    const peer = await tlsPeer(stallingXml(200));
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy), "localhost", {
      ...S3_REQUEST_BOUNDS,
      bodyIdleMs: 300,
    });
    const store = createCheckpointObjectStore({ bucket: "bucket", client });

    const outcome = await store.list("p/").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    client.destroy();

    expect(outcome).toContain("delivered nothing for 300ms");
  }, 20_000);

  test("gives up on a stalled object body and retries it on a fresh connection", async () => {
    const peer = await tlsPeer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n0123456789");
    });
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy));
    const store = createCheckpointObjectStore({
      bodyRead: { ...DEFAULT_BODY_READ_BOUNDS, attempts: 2, stallMs: 300 },
      bucket: "bucket",
      client,
    });

    const outcome = await store.get("stalled").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    client.destroy();

    expect(outcome).toContain("stalled 2 times");
    expect(peer.heads).toHaveLength(2);
    await until(() => peer.open() === 0);
  }, 20_000);

  test("fails a body that drips forever inside the read budget, once", async () => {
    const timers: ReturnType<typeof setInterval>[] = [];
    closers.push(() => {
      for (const timer of timers) clearInterval(timer);
    });
    const peer = await tlsPeer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-length: 1000000\r\n\r\n");
      const timer = setInterval(() => socket.write("x"), 20);
      timers.push(timer);
      socket.on("close", () => clearInterval(timer));
    });
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy));
    const store = createCheckpointObjectStore({
      bodyRead: { ...DEFAULT_BODY_READ_BOUNDS, maxReadMs: 500, stallMs: 5_000 },
      bucket: "bucket",
      client,
    });

    const outcome = await store.get("drip").then(
      () => "resolved",
      (error: Error) => error.message,
    );
    client.destroy();

    expect(outcome).toContain("took longer than 500ms");
    expect(peer.heads).toHaveLength(1);
  }, 20_000);

  test("an abort before the headers rejects at once and is not retried", async () => {
    const peer = await tlsPeer(() => undefined);
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const error = await client
      .send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }), {
        abortSignal: controller.signal,
      })
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    client.destroy();

    expect(error?.name).toBe("AbortError");
    expect(peer.heads).toHaveLength(1);
    await until(() => peer.open() === 0);
  }, 20_000);

  test("an abort after the headers ends the body", async () => {
    const peer = await tlsPeer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n0123456789");
    });
    const proxy = await tunnellingProxy();
    const client = clientFor(peer.port, routeVia(proxy));
    const controller = new AbortController();

    const response = await client.send(
      new GetObjectCommand({ Bucket: "bucket", Key: "k" }),
      { abortSignal: controller.signal },
    );
    const read = (async () => {
      for await (const _ of response.Body as AsyncIterable<Uint8Array>) {
        // drained until the abort ends it
      }
    })();
    controller.abort();
    await expect(read).rejects.toThrow();
    client.destroy();
    await until(() => peer.open() === 0);
  }, 20_000);
});

describe("TlsTunnelHttpHandler response framing", () => {
  test("decodes a chunked body with extensions and trailers byte for byte", async () => {
    const result = await exchange((socket) => {
      socket.write(
        "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n" +
          "5;name=value\r\nhello\r\n1\r\n \r\n5\r\nworld\r\n0\r\nx-trailer: t\r\n\r\n",
      );
    });
    expect(result.statusCode).toBe(200);
    expect(result.text).toBe("hello world");
  });

  test("reads a close-delimited body to the end of the connection", async () => {
    const result = await exchange((socket) => {
      socket.end("HTTP/1.1 200 OK\r\n\r\nuntil close");
    });
    expect(result.text).toBe("until close");
  });

  test("skips informational responses before the final one", async () => {
    const result = await exchange((socket) => {
      socket.write(
        "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nlink: x\r\n\r\n" +
          "HTTP/1.1 204 No Content\r\n\r\n",
      );
    });
    expect(result.statusCode).toBe(204);
    expect(result.text).toBe("");
  });

  test("a HEAD response ends without waiting for the body its length describes", async () => {
    const result = await exchange(
      (socket) => {
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n");
      },
      { method: "HEAD" },
    );
    expect(result.headers["content-length"]).toBe("100");
    expect(result.text).toBe("");
  });

  test("a body cut short of its content-length is an error, not a short read", async () => {
    const result = await exchange((socket) => {
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nonly this");
    });
    expect(result.error?.message).toContain("91 bytes short");
    expect((result.error as { code?: string }).code).toBe("ECONNRESET");
  });

  test("a chunked body cut off mid-chunk is an error", async () => {
    const result = await exchange((socket) => {
      socket.end(
        "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\na\r\nhello",
      );
    });
    expect(result.error?.message).toContain("inside a chunked body");
  });

  test("conflicting framing is refused rather than guessed at", async () => {
    const result = await exchange((socket) => {
      socket.write(
        "HTTP/1.1 200 OK\r\ncontent-length: 3\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n",
      );
    });
    expect(result.error?.message).toContain(
      "both transfer-encoding and content-length",
    );
  });

  test("an endless run of informational responses is cut off", async () => {
    const peer = await tlsPeer((socket) => {
      const flood = setInterval(() => {
        if (socket.destroyed) clearInterval(flood);
        else
          socket.write(
            "HTTP/1.1 100 Continue\r\nx: ".concat("y".repeat(1000), "\r\n\r\n"),
          );
      }, 1);
    });
    const handler = new TlsTunnelHttpHandler(S3_REQUEST_BOUNDS, {
      ca: named.cert,
      noProxy: [],
    });
    await expect(handler.handle(requestTo(peer.port))).rejects.toThrow(
      "exceeded 64 KiB",
    );
  });

  test("an early final answer to an upload is heard while the upload still drains", async () => {
    // The peer answers a 32 MiB PUT with 412 after reading nothing: a client
    // that waits for its upload to finish before reading would deadlock.
    const peer = await tlsPeer(
      (socket) => {
        socket.write(
          "HTTP/1.1 412 Precondition Failed\r\ncontent-length: 0\r\n\r\n",
        );
      },
      { answerOnHead: true },
    );
    const handler = new TlsTunnelHttpHandler(S3_REQUEST_BOUNDS, {
      ca: named.cert,
      noProxy: [],
    });
    const { response } = await handler.handle(
      requestTo(peer.port, {
        body: new Uint8Array(32 * 1024 * 1024),
        method: "PUT",
      }),
    );
    expect(response.statusCode).toBe(412);
    handler.destroy();
  }, 20_000);

  test("a stream request body is refused rather than sent unframed", async () => {
    const handler = new TlsTunnelHttpHandler(S3_REQUEST_BOUNDS, {
      noProxy: [],
    });
    await expect(
      handler.handle(
        requestTo(1, { body: Readable.from(["x"]), method: "PUT" }),
      ),
    ).rejects.toThrow("only byte bodies");
  });
});

describe("egress route", () => {
  test("reads the lower-case variables first and accepts only a plain http proxy", () => {
    expect(
      egressRouteFromEnv({
        HTTPS_PROXY: "http://upper:1",
        NO_PROXY: "upper",
        https_proxy: "http://lower:3128",
        no_proxy: " Localhost , .internal ,",
      }),
    ).toEqual({
      noProxy: ["localhost", ".internal"],
      proxy: new URL("http://lower:3128"),
    });
    expect(egressRouteFromEnv({})).toEqual({ noProxy: [] });
    expect(() => egressRouteFromEnv({ HTTPS_PROXY: "https://p:1" })).toThrow(
      "http:// proxy",
    );
    expect(() => egressRouteFromEnv({ HTTPS_PROXY: "http://p:1/x" })).toThrow(
      "only a host and port",
    );
    expect(() => egressRouteFromEnv({ HTTPS_PROXY: "p" })).toThrow("not a URL");
  });

  test("matches NO_PROXY entries the way curl does", () => {
    const entries = [
      "localhost",
      ".internal",
      "db:5432",
      "::1",
      "[fe80::1]:443",
    ];
    expect(bypassesProxy("localhost", 443, entries)).toBe(true);
    expect(bypassesProxy("s3.internal", 443, entries)).toBe(true);
    expect(bypassesProxy("internal", 443, entries)).toBe(true);
    expect(bypassesProxy("notinternal", 443, entries)).toBe(false);
    expect(bypassesProxy("db", 5432, entries)).toBe(true);
    expect(bypassesProxy("db", 443, entries)).toBe(false);
    expect(bypassesProxy("[::1]", 443, entries)).toBe(true);
    expect(bypassesProxy("fe80::1", 443, entries)).toBe(true);
    expect(bypassesProxy("fe80::1", 80, entries)).toBe(false);
    expect(bypassesProxy("s3.amazonaws.com", 443, entries)).toBe(false);
    expect(bypassesProxy("anything", 1, ["*"])).toBe(true);
  });
});

type PeerRequest = { body: Buffer; head: string };
type PeerOptions = {
  /** Answer as soon as the head is in, without reading the body. */
  answerOnHead?: boolean;
  certificate?: Certificate;
};
type Peer = {
  connections: number;
  heads: string[];
  open: () => number;
  port: number;
  servernames: Array<string | false>;
};

/**
 * A raw TLS server that hands each complete request (head and
 * content-length body) to `answer`, which writes whatever bytes it likes.
 */
async function tlsPeer(
  answer: (socket: TLSSocket, request: PeerRequest) => void,
  options: PeerOptions = {},
): Promise<Peer> {
  const certificate = options.certificate ?? named;
  const sockets = new Set<TLSSocket>();
  const peer: Peer = {
    connections: 0,
    heads: [],
    open: () => sockets.size,
    port: 0,
    servernames: [],
  };
  const server = createTlsServer(certificate, (socket) => {
    peer.connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    peer.servernames.push(socket.servername ?? false);
    let buffered = Buffer.alloc(0);
    let head: string | undefined;
    let wanted = 0;
    const onBytes = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (head === undefined) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        head = buffered.subarray(0, end).toString("latin1");
        buffered = buffered.subarray(end + 4);
        peer.heads.push(head);
        wanted = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (options.answerOnHead) {
          answer(socket, { body: Buffer.alloc(0), head });
          return;
        }
      }
      if (options.answerOnHead) return;
      if (buffered.byteLength >= wanted) {
        const request = { body: buffered.subarray(0, wanted), head };
        wanted = Number.POSITIVE_INFINITY;
        answer(socket, request);
      }
    };
    socket.on("data", onBytes);
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  peer.port = await listen(server);
  return peer;
}

/** Just enough S3 for a checkpoint store: objects in a map, lists chunked. */
async function fakeS3(options: PeerOptions = {}): Promise<Peer> {
  const objects = new Map<string, Buffer>();
  return tlsPeer((socket, { body, head }) => {
    const [method = "", target = ""] = head.split(" ");
    const url = new URL(target, "https://s3.test");
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
    const reply = (status: string, headers: string[], payload = "") =>
      socket.end(
        [
          `HTTP/1.1 ${status}`,
          ...headers,
          `content-length: ${Buffer.byteLength(payload)}`,
          "",
          payload,
        ].join("\r\n"),
      );
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map(
          (name) =>
            `<Contents><Key>${name}</Key><Size>${objects.get(name)?.byteLength}</Size></Contents>`,
        )
        .join("");
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bucket</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
      const half = Math.floor(xml.length / 2);
      socket.end(
        "HTTP/1.1 200 OK\r\ncontent-type: application/xml\r\ntransfer-encoding: chunked\r\n\r\n" +
          `${Buffer.byteLength(xml.slice(0, half)).toString(16)};ext=1\r\n${xml.slice(0, half)}\r\n` +
          `${Buffer.byteLength(xml.slice(half)).toString(16)}\r\n${xml.slice(half)}\r\n0\r\nx-amz-trailer: none\r\n\r\n`,
      );
      return;
    }
    const stored = objects.get(key);
    if (method === "PUT") {
      if (/\r\nif-none-match: \*/i.test(head) && stored) {
        reply(
          "412 Precondition Failed",
          ["content-type: application/xml"],
          "<Error><Code>PreconditionFailed</Code></Error>",
        );
        return;
      }
      objects.set(key, Buffer.from(body));
      reply("200 OK", ['etag: "e"']);
      return;
    }
    if (!stored) {
      reply(
        "404 Not Found",
        ["content-type: application/xml"],
        method === "HEAD" ? "" : "<Error><Code>NoSuchKey</Code></Error>",
      );
      return;
    }
    if (method === "HEAD") {
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-length: ${stored.byteLength}\r\n\r\n`,
      );
      return;
    }
    socket.write(
      `HTTP/1.1 200 OK\r\ncontent-length: ${stored.byteLength}\r\n\r\n`,
    );
    socket.end(stored);
  }, options);
}

/** Answers with `status` and a few bytes of XML, then stops. */
function stallingXml(status: number) {
  return (socket: TLSSocket) => {
    socket.write(
      `HTTP/1.1 ${status} X\r\ncontent-length: 200\r\ncontent-type: application/xml\r\n\r\n<?xml version=`,
    );
  };
}

type Proxy = { connects: string[]; port: number };

/**
 * A CONNECT proxy that tunnels every request to 127.0.0.1 on the requested
 * port, or refuses them all with `refuse`.
 */
async function tunnellingProxy(
  options: { refuse?: number } = {},
): Promise<Proxy> {
  const proxy: Proxy = { connects: [], port: 0 };
  const sockets = new Set<Socket>();
  const server = createNetServer((client) => {
    sockets.add(client);
    client.on("error", () => undefined);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      proxy.connects.push(line);
      if (options.refuse) {
        client.end(
          `HTTP/1.1 ${options.refuse} Refused\r\ncontent-length: 0\r\n\r\n`,
        );
        return;
      }
      const port = Number(/:(\d+) HTTP/.exec(line)?.[1]);
      const upstream = netConnect({ host: "127.0.0.1", port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    };
    client.on("data", onData);
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  proxy.port = await listen(server);
  return proxy;
}

/** Accepts TCP connections and never writes a byte. */
async function plainListener(): Promise<{
  accepted: () => number;
  port: number;
}> {
  const sockets: Socket[] = [];
  const server: Server = createNetServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    socket.resume();
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { accepted: () => sockets.length, port: await listen(server) };
}

function proxyUrl(proxy: Proxy): URL {
  return new URL(`http://127.0.0.1:${proxy.port}`);
}

function routeVia(proxy: Proxy, certificate: Certificate = named): EgressRoute {
  return { ca: certificate.cert, noProxy: [], proxy: proxyUrl(proxy) };
}

function clientFor(
  port: number,
  route: EgressRoute,
  host = "localhost",
  bounds: S3RequestBounds = S3_REQUEST_BOUNDS,
) {
  return createStorageS3Client(
    {
      s3: {
        accessKeyId: "test",
        endpoint: `https://${host}:${port}`,
        region: "ap-northeast-1",
        secretAccessKey: "test",
      },
    },
    bounds,
    route,
  );
}

function requestTo(
  port: number,
  overrides: Partial<ConstructorParameters<typeof HttpRequest>[0]> = {},
): HttpRequest {
  return new HttpRequest({
    headers: {},
    hostname: "localhost",
    method: "GET",
    path: "/bucket/key",
    port,
    protocol: "https:",
    query: {},
    ...overrides,
  });
}

/** One direct exchange with a raw peer, body collected or its error kept. */
async function exchange(
  answer: (socket: TLSSocket) => void,
  overrides: Partial<ConstructorParameters<typeof HttpRequest>[0]> = {},
): Promise<{
  error?: Error;
  headers: Record<string, string>;
  statusCode: number;
  text: string;
}> {
  const peer = await tlsPeer(answer);
  const handler = new TlsTunnelHttpHandler(S3_REQUEST_BOUNDS, {
    ca: named.cert,
    noProxy: [],
  });
  const { response } = await handler.handle(requestTo(peer.port, overrides));
  const parts: Buffer[] = [];
  let error: Error | undefined;
  try {
    for await (const part of response.body as AsyncIterable<Buffer>) {
      parts.push(part);
    }
  } catch (caught) {
    error = caught as Error;
  }
  handler.destroy();
  return {
    ...(error ? { error } : {}),
    headers: response.headers,
    statusCode: response.statusCode,
    text: Buffer.concat(parts).toString("utf8"),
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a port");
  }
  return address.port;
}

async function mintCertificate(
  name: string,
  san: string,
): Promise<Certificate> {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const generate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=${san}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  if ((await generate.exited) !== 0) {
    throw new Error(
      `openssl could not mint a test certificate:\n${await new Response(generate.stderr).text()}`,
    );
  }
  return {
    cert: await Bun.file(certPath).text(),
    key: await Bun.file(keyPath).text(),
  };
}

async function until(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(20);
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
