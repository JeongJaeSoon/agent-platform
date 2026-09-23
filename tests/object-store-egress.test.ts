import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import type { ProxyLogger } from "@agent-platform/egress-proxy/src/proxy.ts";
import { startEgressProxy } from "@agent-platform/egress-proxy/src/proxy.ts";
import { parseClientHelloSni } from "@agent-platform/egress-proxy/src/tls.ts";
import {
  createLocalstackBucket,
  type LocalstackBucket,
  localstackEnabled,
  localstackEnv,
} from "@agent-platform/testkit/localstack";

import {
  createWorkerObjectStore,
  objectStoreConfigFromEnv,
} from "../apps/worker/src/object-store.ts";

/**
 * The worker's object store over https, behind the egress proxy (94S-254).
 *
 * The proxy refuses any ClientHello carrying `encrypted_client_hello`, and
 * Bun's own https clients send a GREASE one on every hello (94S-219). The
 * first half of this file reads the hello the real factory sends; the second
 * runs the real factory in a child process, the way a worker container
 * does, through the real proxy to LocalStack behind a TLS front.
 */

const REPOSITORY = resolve(import.meta.dir, "..");
const closers: Array<() => void> = [];
let directory = "";
let certificate: { cert: string; key: string; path: string };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "object-store-egress-"));
  certificate = await mintCertificate(directory);
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const base = {
  AWS_ACCESS_KEY_ID: "test",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "not-a-real-secret",
  NO_PROXY: "egress-proxy.invalid",
  S3_BUCKET: "claude-sessions",
  WORKER_OBJECT_PREFIX: "sessions/s1/",
};

describe("the ClientHello the worker's object store sends", () => {
  test("carries the endpoint's name and no encrypted_client_hello", async () => {
    // With no endpoint configured the SDK falls back to AWS_ENDPOINT_URL in
    // the process environment, which the LocalStack suites set; the AWS case
    // below is only AWS without it.
    const inherited = process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_ENDPOINT_URL;
    closers.push(() => {
      if (inherited !== undefined) process.env.AWS_ENDPOINT_URL = inherited;
    });
    const sniffer = await sniffingProxy();
    for (const endpoint of ["https://objects.example:9443", undefined]) {
      const store = createWorkerObjectStore(
        objectStoreConfigFromEnv({
          ...base,
          AWS_ENDPOINT_URL: endpoint,
          HTTPS_PROXY: sniffer.url,
        }),
      );
      await expect(store.get("sessions/s1/x")).rejects.toThrow();
    }
    // The SDK retries the hang-up, so each store says hello more than once;
    // every one of them is what the egress proxy accepts.
    expect(new Set(sniffer.verdicts.map((v) => JSON.stringify(v)))).toEqual(
      new Set([
        JSON.stringify({ host: "objects.example", kind: "sni" }),
        JSON.stringify({
          host: "claude-sessions.s3.ap-northeast-1.amazonaws.com",
          kind: "sni",
        }),
      ]),
    );
  }, 30_000);

  test("the same listener does see the GREASE ECH in Bun's own fetch", async () => {
    // The control: without it a listener that never finds ECH would pass
    // the case above for the wrong reason.
    const sniffer = await sniffingProxy();
    await fetch("https://objects.example:9443/", {
      proxy: sniffer.url,
      signal: AbortSignal.timeout(5_000),
    } as RequestInit).catch(() => undefined);
    expect(sniffer.verdicts[0]).toMatchObject({ kind: "reject" });
    expect(JSON.stringify(sniffer.verdicts[0])).toContain(
      "encrypted_client_hello",
    );
  }, 30_000);
});

const localstackTest = localstackEnabled() ? test : test.skip;

describe("the worker's object store through the egress proxy to an https S3", () => {
  let bucket: LocalstackBucket | undefined;

  afterEach(async () => {
    await bucket?.destroy().catch(() => undefined);
    bucket = undefined;
  });

  localstackTest(
    "puts, reads, heads and lists under its prefix, over CONNECT only",
    async () => {
      bucket = await createLocalstackBucket({ prefix: "object-store-egress" });
      const front = await tlsFront(new URL(localstackEnv().endpoint));
      const { allowed, denied, url } = await egressProxyFor(front.port);

      const result = await runFactory({
        ...base,
        AWS_ENDPOINT_URL: `https://localhost:${front.port}`,
        HTTPS_PROXY: url,
        HTTP_PROXY: url,
        NODE_EXTRA_CA_CERTS: certificate.path,
        S3_BUCKET: bucket.bucket,
        https_proxy: url,
        http_proxy: url,
      });

      expect(result).toEqual({
        conflict: "conflict",
        duplicate: "duplicate",
        get: '{"revision":0}',
        head: 14,
        list: ["sessions/s1/checkpoints/0000000000/manifest.json"],
        putImmutable: "created",
        transcript: "part",
      });
      expect(denied).toEqual([]);
      expect(new Set(allowed)).toEqual(
        new Set([`connect localhost:${front.port}`]),
      );
      expect(front.connections()).toBeGreaterThan(0);
    },
    60_000,
  );
});

type Verdict = ReturnType<typeof parseClientHelloSni>;

/**
 * Answers CONNECT with 200, reads the first TLS record(s) up to a verdict,
 * and hangs up: what the egress proxy's gate sees, without the gate.
 */
async function sniffingProxy(): Promise<{ url: string; verdicts: Verdict[] }> {
  const verdicts: Verdict[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    let buffered = Buffer.alloc(0);
    let tunnelled = false;
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!tunnelled) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        tunnelled = true;
        buffered = buffered.subarray(end + 4);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      }
      const verdict = parseClientHelloSni(new Uint8Array(buffered));
      if (verdict.kind === "incomplete") return;
      verdicts.push(verdict);
      socket.destroy();
    });
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { url: `http://127.0.0.1:${await listen(server)}`, verdicts };
}

/** The real egress proxy, allowing only the TLS front, by name. */
async function egressProxyFor(port: number) {
  const allowed: string[] = [];
  const denied: string[] = [];
  const logger: ProxyLogger = {
    debug() {},
    error(message, fields) {
      denied.push(`${message} ${JSON.stringify(fields ?? {})}`);
    },
    info(message, fields) {
      if (message === "Egress allowed") {
        allowed.push(`${fields?.method} ${fields?.host}:${fields?.port}`);
      }
    },
    warn(message, fields) {
      denied.push(`${message} ${JSON.stringify(fields ?? {})}`);
    },
  };
  const proxy = await startEgressProxy({
    hostname: "127.0.0.1",
    logger,
    policy: { allow: [], allowPrivate: [{ host: "localhost", port }] },
    port: 0,
  });
  closers.push(() => proxy.stop());
  return { allowed, denied, url: `http://127.0.0.1:${proxy.port}` };
}

/**
 * TLS in front of LocalStack's plain port: decrypts and relays bytes, so
 * what the transport parses is LocalStack's own HTTP.
 */
async function tlsFront(upstream: URL) {
  let connections = 0;
  const sockets: Socket[] = [];
  const server = createTlsServer(certificate, (client) => {
    connections += 1;
    sockets.push(client);
    const target = connect({
      host: upstream.hostname,
      port: Number(upstream.port || 80),
    });
    sockets.push(target);
    client.pipe(target);
    target.pipe(client);
    client.on("error", () => target.destroy());
    target.on("error", () => client.destroy());
    client.on("close", () => target.destroy());
    target.on("close", () => client.destroy());
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  // Every loopback address: the proxy resolves "localhost" and may try ::1
  // first, and a refused attempt there would read as a denial below.
  return { connections: () => connections, port: await listen(server, "::") };
}

/**
 * The worker's factory in its own process, as in a container: the CA comes
 * from `NODE_EXTRA_CA_CERTS`, the route from the proxy variables.
 */
async function runFactory(
  environment: Record<string, string>,
): Promise<Record<string, unknown>> {
  const script = join(directory, `probe-${crypto.randomUUID()}.ts`);
  await writeFile(script, PROBE);
  const child = Bun.spawn([process.execPath, "run", script], {
    cwd: REPOSITORY,
    env: { HOME: directory, PATH: process.env.PATH ?? "", ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 45_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  const line = stdout.split("\n").find((entry) => entry.startsWith("PROBE "));
  if (code !== 0 || !line) {
    throw new Error(`probe exited ${code}:\n${stdout}\n${stderr}`);
  }
  return JSON.parse(line.slice("PROBE ".length)) as Record<string, unknown>;
}

const PROBE = `
const { createWorkerObjectStore, objectStoreConfigFromEnv } = await import(
  ${JSON.stringify(join(REPOSITORY, "apps/worker/src/object-store.ts"))}
);
const store = createWorkerObjectStore(objectStoreConfigFromEnv(process.env));
const prefix = process.env.WORKER_OBJECT_PREFIX;
const key = prefix + "checkpoints/0000000000/manifest.json";
const encode = (text) => new TextEncoder().encode(text);
const report = {};
report.putImmutable = (await store.putImmutable(key, encode('{"revision":0}'))).outcome;
report.duplicate = (await store.putImmutable(key, encode('{"revision":0}'))).outcome;
report.conflict = (await store.putImmutable(key, encode('{"revision":1}'))).outcome;
await store.put(prefix + "transcript/part-0", encode("part"));
report.transcript = new TextDecoder().decode(await store.get(prefix + "transcript/part-0"));
report.get = new TextDecoder().decode(await store.get(key));
report.head = (await store.head(key))?.bytes;
report.list = await store.list(prefix + "checkpoints/");
console.log("PROBE " + JSON.stringify(report));
`;

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((done) => server.listen(0, host, done));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a port");
  }
  return address.port;
}

async function mintCertificate(
  into: string,
): Promise<{ cert: string; key: string; path: string }> {
  const certPath = join(into, "front.crt");
  const keyPath = join(into, "front.key");
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
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
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
    path: certPath,
  };
}
