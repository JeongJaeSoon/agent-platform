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
const BIG = "a".repeat(8 * 1024 * 1024);

type EchoState = { pending: Uint8Array | null };

function echoDrain(socket: {
  data: EchoState;
  write(data: Uint8Array): number;
}): void {
  while (socket.data.pending !== null) {
    const written = Math.max(0, socket.write(socket.data.pending));
    if (written >= socket.data.pending.byteLength) {
      socket.data.pending = null;
      return;
    }
    if (written === 0) return;
    socket.data.pending = socket.data.pending.subarray(written);
  }
}

describe("egress proxy", () => {
  let upstream: Bun.Server<undefined>;
  let upstreamPort = 0;
  let echo: TCPSocketListener<EchoState>;
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
      fetch: async (request) => {
        const url = new URL(request.url);
        // A body far past a socket's write buffer, so the proxy has to queue
        // and drain rather than write it all in one go.
        if (url.pathname === "/large") return new Response(BIG);
        return new Response(`upstream ${url.pathname} ${await request.text()}`);
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    upstreamPort = upstream.port ?? 0;
    // An echo server that respects backpressure; one that does not would
    // drop bytes under load and make the proxy look like the culprit.
    echo = Bun.listen<EchoState>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.data.pending = socket.data.pending
            ? concatBytes(socket.data.pending, chunk)
            : chunk;
          echoDrain(socket);
        },
        drain(socket) {
          echoDrain(socket);
        },
        open(socket) {
          socket.data = { pending: null };
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

  test("a client that outruns the upstream handshake is dropped", async () => {
    // The connecting window is bounded in time, not in bytes, unless the
    // proxy bounds it; a slow resolver makes that window observable.
    const slow = await startEgressProxy({
      logger: silent,
      maxBufferedBytes: 64,
      policy: {
        allow: [],
        allowPrivate: [{ host: "tunnel.test", port: echo.port }],
      },
      port: 0,
      resolve: async (host) => {
        await Bun.sleep(300);
        return resolve(host);
      },
    });
    try {
      const talk = await connect(slow.port);
      talk.send(
        `${request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`)}${"x".repeat(200)}`,
      );
      await Bun.sleep(800);
      expect(talk.text()).not.toContain("200 Connection Established");
      expect(talk.isClosed()).toBe(true);
    } finally {
      slow.stop();
    }
  }, 10_000);

  test("a response far larger than a socket buffer arrives whole", async () => {
    // With the drain handlers wired to the wrong queues this stalls, and
    // with an eager close on upstream end it truncates.
    const talk = await connect(proxy.port);
    talk.send(
      request(`GET http://gateway.test:${upstreamPort}/large HTTP/1.1`),
    );
    const received = await talk.waitForBytes(BIG.length, 30_000);
    expect(received).toBeGreaterThanOrEqual(BIG.length);
    talk.close();
  }, 60_000);

  test("a client slower than the upstream still gets every byte", async () => {
    // Burning 30ms inside every data callback makes this client slower than
    // a loopback upstream by far more than the cap below. The proxy used to
    // answer that by dropping the connection half way down, which reaches a
    // worker as a truncated file rather than as an error it can retry.
    const tight = await startEgressProxy({
      logger: silent,
      maxBufferedBytes: 64 * 1024,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve,
    });
    try {
      const talk = await connect(tight.port, 30);
      talk.send(
        request(`GET http://gateway.test:${upstreamPort}/large HTTP/1.1`),
      );
      const received = await talk.waitForBytes(BIG.length, 60_000);
      expect(received).toBeGreaterThanOrEqual(BIG.length);
      talk.close();
    } finally {
      tight.stop();
    }
  }, 120_000);

  test("a client that stops reading is dropped once its queue goes stale", async () => {
    // The other half of the same rule: pausing the upstream is the answer to
    // a slow client, and this deadline is the answer to one that never reads
    // again. Nothing else reaps a connection past its request head, so
    // without it a worker could hold a slot and its buffer for good.
    const warnings: string[] = [];
    const strict = await startEgressProxy({
      logger: createProxyLogger("warn", (line) => warnings.push(line)),
      maxBufferedBytes: 64 * 1024,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve,
      stallTimeoutMs: 300,
    });
    try {
      const talk = await connect(strict.port);
      talk.send(
        request(`GET http://gateway.test:${upstreamPort}/large HTTP/1.1`),
      );
      talk.stopReading();
      // A paused socket never reads the FIN either, so the close only shows
      // up once it starts reading again — which is why the proxy's own
      // account of giving up is what this waits on.
      const dropped = await waitFor(
        () => warnings.some((line) => line.includes("client fell behind")),
        10_000,
      );
      expect(dropped).toBe(true);
      talk.resumeReading();
      expect(await waitFor(() => talk.isClosed(), 10_000)).toBe(true);
      expect(talk.byteCount()).toBeLessThan(BIG.length);
    } finally {
      strict.stop();
    }
  }, 30_000);

  test("a large upload through a tunnel comes back whole", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    const payload = "b".repeat(2 * 1024 * 1024);
    talk.send(payload);
    const received = await talk.waitForBytes(payload.length, 30_000);
    expect(received).toBeGreaterThanOrEqual(payload.length);
    talk.close();
  }, 60_000);

  test("an oversized head is refused even when it arrives all at once", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      `GET http://gateway.test/ HTTP/1.1\r\nx-pad: ${"a".repeat(20_000)}\r\n\r\n`,
    );
    expect(await talk.waitFor("431")).toContain("too large");
    talk.close();
  });

  test("idle clients cannot hold the connection budget for good", async () => {
    const small = await startEgressProxy({
      headTimeoutMs: 300,
      logger: silent,
      maxConnections: 2,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve,
    });
    try {
      const idle = [await connect(small.port), await connect(small.port)];
      const refused = await connect(small.port);
      expect(await refused.waitFor("503")).toContain("connection limit");
      refused.close();

      // The head deadline hands the slots back without anyone intervening.
      for (const one of idle) {
        expect(await one.waitFor("408")).toContain("timed out");
      }
      const after = await connect(small.port);
      after.send(
        request(`GET http://gateway.test:${upstreamPort}/ok HTTP/1.1`),
      );
      expect(await after.waitFor("upstream /ok")).toContain("HTTP/1.1 200");
      after.close();
      for (const one of idle) one.close();
    } finally {
      small.stop();
    }
  }, 30_000);

  test("one client cannot take more than its share of connections", async () => {
    const capped = await startEgressProxy({
      headTimeoutMs: 10_000,
      logger: silent,
      maxConnections: 64,
      maxConnectionsPerClient: 1,
      policy: { allow: [], allowPrivate: [] },
      port: 0,
      resolve,
    });
    try {
      const first = await connect(capped.port);
      const second = await connect(capped.port);
      expect(await second.waitFor("503")).toContain("this client");
      first.close();
      second.close();
    } finally {
      capped.stop();
    }
  }, 20_000);

  test("a client that leaves mid-connect keeps its slot until that settles", async () => {
    let letResolve: (() => void) | undefined;
    const gate = new Promise<void>((done) => {
      letResolve = done;
    });
    let resolving = 0;
    const slow = await startEgressProxy({
      headTimeoutMs: 20_000,
      logger: silent,
      maxConnections: 64,
      maxConnectionsPerClient: 1,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve: async () => {
        resolving += 1;
        await gate;
        return ["127.0.0.1"];
      },
    });
    try {
      const first = await connect(slow.port);
      first.send(
        request(`GET http://gateway.test:${upstreamPort}/slow HTTP/1.1`),
      );
      while (resolving === 0) await Bun.sleep(5);

      // Gone from the client's side, but the outbound attempt it started is
      // still alive, so the slot it is spending must not come back yet.
      first.close();
      await Bun.sleep(50);
      const second = await connect(slow.port);
      expect(await second.waitFor("503")).toContain("this client");
      second.close();

      letResolve?.();
      const after = await connect(slow.port);
      after.send(
        request(`GET http://gateway.test:${upstreamPort}/ok HTTP/1.1`),
      );
      expect(await after.waitFor("upstream /ok")).toContain("HTTP/1.1 200");
      after.close();
    } finally {
      letResolve?.();
      slow.stop();
    }
  }, 30_000);

  test("a name lookup that never answers still gives the slot back", async () => {
    const stuck = await startEgressProxy({
      dispatchTimeoutMs: 300,
      headTimeoutMs: 20_000,
      logger: silent,
      maxConnections: 64,
      maxConnectionsPerClient: 1,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      // The OS resolver can hang; nothing in this process can cancel it.
      resolve: () => new Promise<string[]>(() => undefined),
    });
    try {
      const first = await connect(stuck.port);
      first.send(
        request(`GET http://gateway.test:${upstreamPort}/hang HTTP/1.1`),
      );
      expect(await first.waitFor("504")).toContain("timed out");
      first.close();
      await Bun.sleep(50);

      // The slot is back although the lookup never answered: a second
      // request gets its own dispatch instead of the per-client 503.
      const second = await connect(stuck.port);
      second.send(
        request(`GET http://gateway.test:${upstreamPort}/hang HTTP/1.1`),
      );
      expect(await second.waitFor("504")).toContain("timed out");
      second.close();
    } finally {
      stuck.stop();
    }
  }, 20_000);

  test("an attempt that opens after we gave up does not kill the live tunnel", async () => {
    // Address A is dialled first and answers too late; by then B carries the
    // tunnel, so A's teardown must not reach the client.
    let first = true;
    const late = await startEgressProxy({
      connectTimeoutMs: 200,
      // The dial itself is the seam: A connects for real but reports back
      // after the deadline, which is what a slow path looks like from here.
      connect: async (opts) => {
        const socket = await Bun.connect(opts);
        if (first) {
          first = false;
          await Bun.sleep(600);
        }
        return socket;
      },
      logger: silent,
      policy: {
        allow: [],
        allowPrivate: [{ host: "tunnel.test", port: echo.port }],
      },
      port: 0,
      resolve: async () => ["127.0.0.1", "127.0.0.1"],
    });
    try {
      const talk = await connect(late.port);
      talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
      expect(
        await talk.waitFor("200 Connection Established", 10_000),
      ).toContain("200");
      talk.send("before");
      expect(await talk.waitFor("before", 10_000)).toContain("before");

      // Past the abandoned attempt's own arrival, the tunnel is still there.
      await Bun.sleep(800);
      talk.send("after");
      expect(await talk.waitFor("after", 10_000)).toContain("after");
      talk.close();
    } finally {
      late.stop();
    }
  }, 30_000);

  test("a dead address does not fail a destination with a live one", async () => {
    const failover = await startEgressProxy({
      connectTimeoutMs: 2_000,
      logger: silent,
      policy: {
        allow: [],
        allowPrivate: [{ host: "dual.test", port: upstreamPort }],
      },
      port: 0,
      // 127.0.0.2 is loopback with nothing listening; both addresses pass
      // the same policy, so the second must still be tried.
      resolve: async () => ["127.0.0.2", "127.0.0.1"],
    });
    try {
      const talk = await connect(failover.port);
      talk.send(
        request(`GET http://dual.test:${upstreamPort}/failover HTTP/1.1`),
      );
      expect(await talk.waitFor("upstream /failover", 15_000)).toContain(
        "HTTP/1.1 200",
      );
      talk.close();
    } finally {
      failover.stop();
    }
  }, 30_000);

  test("an oversized request head is refused instead of buffered", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      `GET http://gateway.test/ HTTP/1.1\r\nx-pad: ${"a".repeat(20_000)}\r\n`,
    );
    expect(await talk.waitFor("431")).toContain("too large");
    talk.close();
  });
});

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(20);
  }
  return false;
}

function request(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n\r\n`;
}

type Conversation = {
  byteCount(): number;
  close(): void;
  isClosed(): boolean;
  send(text: string): void;
  /** Stop draining without closing — a client the proxy has to give up on. */
  stopReading(): void;
  resumeReading(): void;
  text(): string;
  waitFor(needle: string, timeoutMs?: number): Promise<string>;
  waitForBytes(count: number, timeoutMs?: number): Promise<number>;
};

/**
 * `slowReadMs` burns CPU inside the data handler so the client stops
 * draining its socket: that is what forces the proxy into a partial write
 * and makes the drain path run at all.
 */
async function connect(port: number, slowReadMs = 0): Promise<Conversation> {
  let received = "";
  let bytes = 0;
  let closed = false;
  // The client has to respect backpressure too, or a megabyte-scale send
  // silently truncates and the test blames the proxy.
  let outbox: Uint8Array | null = null;
  const drainOutbox = (target: { write(data: Uint8Array): number }): void => {
    while (outbox !== null) {
      const written = Math.max(0, target.write(outbox));
      if (written >= outbox.byteLength) {
        outbox = null;
        return;
      }
      if (written === 0) return;
      outbox = outbox.subarray(written);
    }
  };
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      close() {
        closed = true;
      },
      drain(peer) {
        drainOutbox(peer);
      },
      data(_socket, chunk) {
        if (slowReadMs > 0) {
          const until = Bun.nanoseconds() + slowReadMs * 1_000_000;
          while (Bun.nanoseconds() < until) {
            // spin
          }
        }
        bytes += chunk.byteLength;
        // A megabyte-scale transfer is measured, not accumulated.
        if (received.length < 64 * 1024) {
          received += new TextDecoder().decode(chunk);
        }
      },
    },
  });
  return {
    byteCount(): number {
      return bytes;
    },
    close(): void {
      socket.end();
    },
    isClosed(): boolean {
      return closed;
    },
    send(text: string): void {
      const encoded = new TextEncoder().encode(text);
      outbox = outbox === null ? encoded : concatBytes(outbox, encoded);
      drainOutbox(socket);
    },
    stopReading(): void {
      // Untyped in bun-types; see the note on `reader` in proxy.ts.
      (socket as unknown as { pause(): boolean }).pause();
    },
    resumeReading(): void {
      (socket as unknown as { resume(): boolean }).resume();
    },
    text(): string {
      return received;
    },
    async waitForBytes(count: number, timeoutMs = 20_000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (bytes >= count) return bytes;
        // A short read and a truncated transfer are different failures, and
        // returning the byte count for both once read as "slow" what was a
        // connection the proxy had closed.
        if (closed) throw new Error(`closed after ${bytes} of ${count} bytes`);
        await Bun.sleep(10);
      }
      throw new Error(`timed out after ${bytes} of ${count} bytes`);
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
