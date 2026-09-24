import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { HttpRequest, HttpResponse } from "@smithy/core/protocols";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createStorageS3Client } from "./index.ts";
import { FreshAddressHttpHandler, S3_REQUEST_BOUNDS } from "./s3.ts";

/**
 * A long-lived API or scheduler must follow LocalStack to the address it
 * comes back on (94S-344). DNS is faked with a spy on `Bun.dns.lookup`; the
 * peer is a real loopback server, so the request really is dialed at the
 * address the spy handed out.
 */
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

type Answer = () => ReturnType<typeof Bun.dns.lookup>;
const at =
  (address: string): Answer =>
  async () => [{ address, family: 4, ttl: 600 }];
const notFound: Answer = async () => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
    code: "DNS_ENOTFOUND",
  });
};

function fakeDns(answer: () => Answer) {
  const lookup = spyOn(Bun.dns, "lookup").mockImplementation(
    () => answer()() as never,
  );
  closers.push(() => lookup.mockRestore());
  return lookup;
}

async function objectStore(): Promise<{ hosts: string[]; port: number }> {
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    hosts.push(request.headers.host ?? "");
    response.writeHead(200, { "content-length": "0" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  return { hosts, port: (server.address() as { port: number }).port };
}

function clientFor(port: number) {
  const client = createStorageS3Client({
    s3: {
      accessKeyId: "test",
      endpoint: `http://objects.test:${port}`,
      region: "ap-northeast-1",
      secretAccessKey: "test",
    },
  });
  closers.push(() => client.destroy());
  return client;
}

describe("the S3 client over plain http", () => {
  test("looks the endpoint up with libc for every request and keeps the signed name", async () => {
    const { hosts, port } = await objectStore();
    const lookup = fakeDns(() => at("127.0.0.1"));
    const client = clientFor(port);

    for (let i = 0; i < 3; i++) {
      await client.send(new HeadObjectCommand({ Bucket: "b", Key: `k${i}` }));
    }

    // Three requests, three questions: nothing kept the first answer.
    expect(lookup.mock.calls).toHaveLength(3);
    for (const [hostname, options] of lookup.mock.calls) {
      expect(hostname).toBe("objects.test");
      expect(options).toMatchObject({ backend: "libc" });
    }
    // Dialed at the address, still addressed by name: the host SigV4 signed.
    expect(hosts).toEqual(Array(3).fill(`objects.test:${port}`));
  });

  test("a name that is gone fails as ENOTFOUND and is found again once back", async () => {
    const { hosts, port } = await objectStore();
    let answer = notFound;
    fakeDns(() => answer);
    const client = clientFor(port);

    const down = await client
      .send(new HeadObjectCommand({ Bucket: "b", Key: "k" }))
      .catch((error: unknown) => error);
    expect(down).toMatchObject({ code: "ENOTFOUND" });
    expect(hosts).toEqual([]);

    answer = at("127.0.0.1");
    await client.send(new HeadObjectCommand({ Bucket: "b", Key: "k" }));
    expect(hosts).toEqual([`objects.test:${port}`]);
  });

  // https: the certificate is checked against the name. A proxy: it dials
  // the name, and its allowlist and NO_PROXY match by name (the worker).
  test.each([
    ["https", "https:", undefined],
    ["a request under http_proxy", "http:", "http_proxy"],
    ["a request under ALL_PROXY", "http:", "ALL_PROXY"],
  ] as const)("%s is left to Bun, by name", async (_, protocol, variable) => {
    if (variable) setEnv(variable, "http://proxy.test:3128");
    const lookup = fakeDns(() => at("127.0.0.1"));

    expect(await dialedHost(protocol)).toBe("objects.test");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("a name with several addresses is left to Bun, which tries each", async () => {
    fakeDns(() => async () => [
      { address: "::1", family: 6, ttl: 0 },
      { address: "127.0.0.1", family: 4, ttl: 0 },
    ]);

    expect(await dialedHost("http:")).toBe("objects.test");
  });

  test("a lookup that never answers is held to the connection bound", async () => {
    fakeDns(() => () => new Promise(() => {}));
    const handler = new FreshAddressHttpHandler({
      ...S3_REQUEST_BOUNDS,
      connectionTimeout: 200,
    });
    closers.push(() => handler.destroy());

    const startedAt = Date.now();
    const outcome = await handler
      .handle(plainRequest("http:"))
      .catch((error: Error) => error.name);

    expect(outcome).toBe("TimeoutError");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("an abort ends the wait on a lookup that never answers", async () => {
    fakeDns(() => () => new Promise(() => {}));
    const handler = new FreshAddressHttpHandler(S3_REQUEST_BOUNDS);
    closers.push(() => handler.destroy());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const outcome = await handler
      .handle(plainRequest("http:"), { abortSignal: controller.signal })
      .catch((error: Error) => error.name);

    expect(outcome).toBe("AbortError");
  });
});

function plainRequest(protocol: "http:" | "https:"): HttpRequest {
  return new HttpRequest({
    hostname: "objects.test",
    method: "GET",
    path: "/",
    port: 4566,
    protocol,
  });
}

function setEnv(name: string, value: string): void {
  const saved = process.env[name];
  process.env[name] = value;
  closers.push(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

/** The host the handler hands to node:http, without dialing it. */
async function dialedHost(protocol: "http:" | "https:"): Promise<string> {
  let dialed = "";
  const parent = spyOn(NodeHttpHandler.prototype, "handle").mockImplementation(
    async (request) => {
      dialed = request.hostname;
      return { response: new HttpResponse({ statusCode: 200 }) };
    },
  );
  closers.push(() => parent.mockRestore());
  const handler = new FreshAddressHttpHandler(S3_REQUEST_BOUNDS);
  closers.push(() => handler.destroy());
  await handler.handle(plainRequest(protocol));
  return dialed;
}
