import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import { createProxyLogger } from "./logger.ts";
import type { EgressResolver } from "./policy.ts";
import { type EgressProxyServer, startEgressProxy } from "./proxy.ts";

/**
 * The proxy against real sockets, with only DNS faked: the policy has to
 * believe `gateway.test` is 127.0.0.1 for a loopback upstream to stand in
 * for the daemon host.
 */
describe("egress proxy", () => {
  let upstream: Bun.Server<undefined>;
  let upstreamPort = 0;
  let echo: TCPSocketListener<undefined>;
  let proxy: EgressProxyServer;
  const silent = createProxyLogger("error", () => undefined);

  const resolve: EgressResolver = async (host) => {
    switch (host) {
      case "gateway.test":
      case "tunnel.test":
        return ["127.0.0.1"];
      case "metadata.test":
        return ["169.254.169.254"];
      case "public.test":
        // Allowlisted as public, but answers with a private address.
        return ["10.0.0.7"];
      default:
        throw new Error(`no such host ${host}`);
    }
  };

  beforeAll(async () => {
    upstream = Bun.serve({
      fetch: async (request) =>
        new Response(
          `upstream ${new URL(request.url).pathname} ${await request.text()}`,
        ),
      hostname: "127.0.0.1",
      port: 0,
    });
    upstreamPort = upstream.port ?? 0;
    echo = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.write(chunk);
        },
      },
    });
    proxy = await startEgressProxy({
      logger: silent,
      policy: {
        allow: [{ host: "public.test", port: 443 }],
        allowPrivate: [
          { host: "gateway.test", port: upstreamPort },
          { host: "tunnel.test", port: echo.port },
          { host: "metadata.test", port: 80 },
        ],
      },
      port: 0,
      resolve,
    });
  });

  afterAll(async () => {
    proxy.stop();
    echo.stop(true);
    await upstream.stop(true);
  });

  test("an allowlisted absolute-form request reaches the upstream", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(
        `POST http://gateway.test:${upstreamPort}/v1/turns HTTP/1.1`,
        "content-length: 5",
      ) + "hello",
    );
    const response = await talk.waitFor("upstream");
    expect(response).toContain("HTTP/1.1 200");
    expect(response).toContain("upstream /v1/turns hello");
    talk.close();
  });

  test("a host outside the allowlist gets 403 and no connection", async () => {
    const talk = await connect(proxy.port);
    talk.send(request("GET http://evil.test/ HTTP/1.1"));
    expect(await talk.waitFor("403")).toContain("not allowlisted");
    talk.close();
  });

  test("an allowlisted port is not an allowlist for every port", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`GET http://gateway.test:1/ HTTP/1.1`));
    expect(await talk.waitFor("403")).toContain("not allowlisted");
    talk.close();
  });

  test("a public entry resolving to a private address is refused", async () => {
    const talk = await connect(proxy.port);
    talk.send(request("CONNECT public.test:443 HTTP/1.1"));
    expect(await talk.waitFor("403")).toContain("10.0.0.7 is private");
    talk.close();
  });

  test("link-local is refused even though the host is allowlisted", async () => {
    const talk = await connect(proxy.port);
    talk.send(request("GET http://metadata.test/latest/meta-data/ HTTP/1.1"));
    expect(await talk.waitFor("403")).toContain("link_local");
    talk.close();
  });

  test("CONNECT to an allowlisted destination tunnels raw bytes", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    expect(await talk.waitFor("200 Connection Established")).toContain(
      "HTTP/1.1 200",
    );
    talk.send("ping-through-the-tunnel");
    expect(await talk.waitFor("ping-through-the-tunnel")).toContain(
      "ping-through-the-tunnel",
    );
    talk.close();
  });

  test("bytes pipelined behind CONNECT are not lost", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`) + "early-bytes",
    );
    expect(await talk.waitFor("early-bytes")).toContain(
      "200 Connection Established",
    );
    talk.close();
  });

  test("origin-form is only answered for /healthz", async () => {
    const health = await connect(proxy.port);
    health.send(request("GET /healthz HTTP/1.1"));
    expect(await health.waitFor("ok")).toContain("HTTP/1.1 200");
    health.close();

    const other = await connect(proxy.port);
    other.send(request("GET / HTTP/1.1"));
    expect(await other.waitFor("400")).toContain("absolute-form");
    other.close();
  });

  test("an oversized request head is refused instead of buffered", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      `GET http://gateway.test/ HTTP/1.1\r\nx-pad: ${"a".repeat(20_000)}\r\n`,
    );
    expect(await talk.waitFor("431")).toContain("too large");
    talk.close();
  });
});

function request(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n\r\n`;
}

type Conversation = {
  close(): void;
  send(text: string): void;
  waitFor(needle: string, timeoutMs?: number): Promise<string>;
};

async function connect(port: number): Promise<Conversation> {
  let received = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        received += new TextDecoder().decode(chunk);
      },
    },
  });
  return {
    close(): void {
      socket.end();
    },
    send(text: string): void {
      socket.write(text);
    },
    async waitFor(needle: string, timeoutMs = 5_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (received.includes(needle)) return received;
        await Bun.sleep(10);
      }
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}; saw ${JSON.stringify(received)}`,
      );
    },
  };
}
