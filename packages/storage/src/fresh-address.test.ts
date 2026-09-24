import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { HttpRequest } from "@smithy/core/protocols";
import { createStorageS3Client } from "./index.ts";
import { FreshAddressHttpHandler } from "./s3.ts";

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

  test("https is left to Bun, which checks the certificate against the name", async () => {
    const lookup = fakeDns(() => at("127.0.0.1"));
    const handler = new FreshAddressHttpHandler();
    closers.push(() => handler.destroy());

    const outcome = await handler
      .handle(
        new HttpRequest({
          hostname: "objects.test",
          method: "GET",
          path: "/",
          port: 443,
          protocol: "https:",
        }),
        { abortSignal: AbortSignal.abort() },
      )
      .catch((error: Error) => error.name);

    expect(outcome).toBe("AbortError");
    expect(lookup).not.toHaveBeenCalled();
  });
});
