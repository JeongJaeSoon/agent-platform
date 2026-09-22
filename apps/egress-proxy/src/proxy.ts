import { lookup } from "node:dns/promises";
import type { Socket, TCPSocketListener } from "bun";
import type { ProxyLogger } from "./logger.ts";
import { createProxyLogger } from "./logger.ts";
import {
  decideEgress,
  type EgressPolicy,
  type EgressResolver,
} from "./policy.ts";
import { type ProxyRequest, parseRequestHead } from "./request.ts";

/**
 * A forward proxy that speaks exactly two things: `CONNECT host:port` for
 * TLS, and absolute-form HTTP for the plaintext gateway. Everything else is
 * refused, because everything else is a way to be surprised.
 *
 * It is the only member of the worker network that can route off it, so the
 * allowlist it enforces is the whole of a worker's reachable world.
 */

export const DEFAULT_PROXY_PORT = 3128;
const MAX_HEAD_BYTES = 16 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 256;

export type EgressProxyOptions = {
  connectTimeoutMs?: number;
  hostname?: string;
  logger?: ProxyLogger;
  /** Bytes a stalled peer may leave queued before the pair is dropped. */
  maxBufferedBytes?: number;
  maxConnections?: number;
  policy: EgressPolicy;
  port?: number;
  /** Injected by tests; production resolves through the OS. */
  resolve?: EgressResolver;
};

export type EgressProxyServer = {
  readonly port: number;
  stop(): void;
};

type Queue = { bytes: number; chunks: Uint8Array[] };

type ClientState = {
  buffer: Uint8Array;
  /** Still counted against the concurrency cap. */
  counted: boolean;
  /** Read from the client while the upstream connection was still opening. */
  early: Uint8Array[];
  earlyBytes: number;
  phase: "head" | "connecting" | "piping" | "closed";
  toUpstream: Queue;
  upstream: Socket<undefined> | null;
};

export async function startEgressProxy(
  options: EgressProxyOptions,
): Promise<EgressProxyServer> {
  const logger = options.logger ?? createProxyLogger();
  const resolve = options.resolve ?? systemResolver;
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  let open = 0;

  const listener: TCPSocketListener<ClientState> = Bun.listen<ClientState>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? DEFAULT_PROXY_PORT,
    socket: {
      close(socket) {
        release(socket);
        socket.data.phase = "closed";
        socket.data.upstream?.end();
      },
      data(socket, chunk) {
        onClientData(socket, chunk);
      },
      drain(socket) {
        const upstream = socket.data.upstream;
        if (upstream !== null) flush(upstream, socket.data.toUpstream);
      },
      error(socket, error) {
        logger.warn("Client connection failed", { error: error.message });
        release(socket);
        socket.data.upstream?.end();
      },
      open(socket) {
        socket.data = {
          buffer: new Uint8Array(0),
          counted: true,
          early: [],
          earlyBytes: 0,
          phase: "head",
          toUpstream: { bytes: 0, chunks: [] },
          upstream: null,
        };
        open += 1;
        if (open > maxConnections) {
          logger.warn("Refusing connection over the concurrency cap", {
            max_connections: maxConnections,
          });
          reply(socket, 503, "proxy is at its connection limit");
        }
      },
    },
  });

  function onClientData(socket: Socket<ClientState>, chunk: Uint8Array): void {
    const state = socket.data;
    if (state.phase === "closed") return;
    if (state.phase === "connecting") {
      // The client can keep sending while we resolve and connect; that
      // window is bounded in time but not in bytes unless we bound it.
      state.earlyBytes += chunk.byteLength;
      if (state.earlyBytes > maxBuffered) {
        logger.warn("Dropping a connection that outran the upstream handshake");
        drop(socket);
        return;
      }
      state.early.push(chunk);
      return;
    }
    if (state.phase === "piping") {
      const upstream = state.upstream;
      if (upstream === null) return;
      if (!push(upstream, state.toUpstream, chunk, maxBuffered)) {
        logger.warn("Dropping a connection whose upstream fell behind");
        drop(socket);
      }
      return;
    }
    state.buffer = concat(state.buffer, chunk);
    const end = headEnd(state.buffer);
    if (end < 0) {
      if (state.buffer.byteLength > MAX_HEAD_BYTES) {
        reply(socket, 431, "request head is too large");
      }
      return;
    }
    const head = new TextDecoder().decode(state.buffer.subarray(0, end - 4));
    const rest = state.buffer.slice(end);
    state.buffer = new Uint8Array(0);
    void dispatch(socket, parseRequestHead(head), rest);
  }

  async function dispatch(
    socket: Socket<ClientState>,
    request: ProxyRequest,
    rest: Uint8Array,
  ): Promise<void> {
    const state = socket.data;
    // Read through a call so the type checker does not narrow `phase` across
    // the awaits below: the client can close while we resolve or connect.
    const closed = (): boolean => socket.data.phase === "closed";
    if (request.kind === "health") {
      reply(socket, 200, "ok");
      return;
    }
    if (request.kind === "invalid") {
      logger.warn("Rejecting a malformed proxy request", {
        reason: request.reason,
      });
      reply(socket, request.status, request.reason);
      return;
    }
    state.phase = "connecting";
    if (rest.byteLength > 0) {
      // Bytes pipelined in the same segment as the head are early bytes too,
      // and count against the same cap.
      state.early.push(rest);
      state.earlyBytes += rest.byteLength;
      if (state.earlyBytes > maxBuffered) {
        logger.warn("Dropping a connection that outran the upstream handshake");
        drop(socket);
        return;
      }
    }
    const decision = await decideEgress(
      options.policy,
      { host: request.host, port: request.port },
      resolve,
    );
    if (closed()) return;
    if (!decision.allowed) {
      logger.warn("Egress denied", {
        host: request.host,
        method: request.kind,
        port: request.port,
        reason: decision.reason,
      });
      reply(socket, 403, `egress denied: ${decision.reason}`);
      return;
    }
    const address = decision.addresses[0];
    if (address === undefined) {
      reply(socket, 502, "no address to connect to");
      return;
    }
    let upstream: Socket<undefined>;
    try {
      upstream = await connectUpstream(socket, address, request.port);
    } catch (error) {
      if (closed()) return;
      logger.warn("Upstream connection failed", {
        address,
        error: error instanceof Error ? error.message : String(error),
        host: request.host,
        port: request.port,
      });
      reply(socket, 502, "upstream connection failed");
      return;
    }
    if (closed()) {
      upstream.end();
      return;
    }
    logger.info("Egress allowed", {
      address,
      host: request.host,
      method: request.kind,
      port: request.port,
      scope: decision.scope,
    });
    state.upstream = upstream;
    state.phase = "piping";
    if (request.kind === "connect") {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    } else {
      push(
        upstream,
        state.toUpstream,
        new TextEncoder().encode(request.head),
        maxBuffered,
      );
    }
    state.earlyBytes = 0;
    for (const pending of state.early.splice(0)) {
      if (!push(upstream, state.toUpstream, pending, maxBuffered)) {
        drop(socket);
        return;
      }
    }
  }

  function connectUpstream(
    client: Socket<ClientState>,
    address: string,
    port: number,
  ): Promise<Socket<undefined>> {
    // The client socket and the queue live in this closure rather than in
    // `socket.data`: a connection that fails before `open` never gets its
    // data assigned, and the handlers still have to be able to clean up.
    const toClient: Queue = { bytes: 0, chunks: [] };
    const pending = Bun.connect<undefined>({
      hostname: address,
      port,
      socket: {
        close() {
          // The upstream closing is how a forwarded response ends.
          client.end();
        },
        data(_socket, chunk) {
          if (!push(client, toClient, chunk, maxBuffered)) {
            logger.warn("Dropping a connection whose client fell behind");
            drop(client);
          }
        },
        drain() {
          flush(client, toClient);
        },
        error(_socket, error) {
          logger.warn("Upstream connection failed", { error: error.message });
          client.end();
        },
      },
    });
    // Bun.connect has no deadline of its own; a black-holed address would
    // otherwise hold the client socket open forever.
    let settled = false;
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // The connect may still succeed after we gave up on it; close it
        // rather than leak a socket nobody is reading.
        pending.then((late) => late.end()).catch(() => undefined);
        reject(
          new Error(
            `connect to ${address}:${port} timed out after ${connectTimeoutMs}ms`,
          ),
        );
      }, connectTimeoutMs);
      timer.unref();
    });
    return Promise.race([
      pending.then((socket) => {
        settled = true;
        return socket;
      }),
      deadline,
    ]);
  }

  function release(socket: Socket<ClientState>): void {
    if (!socket.data.counted) return;
    socket.data.counted = false;
    open -= 1;
  }

  function drop(socket: Socket<ClientState>): void {
    socket.data.upstream?.end();
    socket.data.phase = "closed";
    socket.end();
  }

  function reply(
    socket: Socket<ClientState>,
    status: number,
    message: string,
  ): void {
    const body = `${message}\n`;
    socket.data.phase = "closed";
    socket.end(
      `HTTP/1.1 ${status} ${reasonPhrase(status)}\r\n` +
        "content-type: text/plain; charset=utf-8\r\n" +
        `content-length: ${new TextEncoder().encode(body).byteLength}\r\n` +
        "connection: close\r\n\r\n" +
        body,
    );
  }

  logger.info("Egress proxy listening", {
    allow: options.policy.allow.map(describe),
    allow_private: options.policy.allowPrivate.map(describe),
    port: listener.port,
  });
  return {
    port: listener.port,
    stop(): void {
      listener.stop(true);
    },
  };
}

function describe(destination: { host: string; port: number }): string {
  return `${destination.host}:${destination.port}`;
}

const systemResolver: EgressResolver = async (host) => {
  const entries = await lookup(host, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
};

function reasonPhrase(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 431:
      return "Request Header Fields Too Large";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    case 505:
      return "HTTP Version Not Supported";
    default:
      return "Error";
  }
}

/** false once the queue is past the cap, which the caller answers by closing. */
function push(
  target: Socket<unknown>,
  queue: Queue,
  chunk: Uint8Array,
  max: number,
): boolean {
  let remainder = chunk;
  if (queue.chunks.length === 0) {
    // A closed socket reports -1, which must not be read as an offset.
    const written = Math.max(0, target.write(chunk));
    if (written >= chunk.byteLength) return true;
    remainder = chunk.subarray(written);
  }
  queue.chunks.push(remainder);
  queue.bytes += remainder.byteLength;
  return queue.bytes <= max;
}

function flush(target: Socket<unknown>, queue: Queue): void {
  while (queue.chunks.length > 0) {
    const head = queue.chunks[0];
    if (head === undefined) return;
    const written = Math.max(0, target.write(head));
    if (written === 0) return;
    queue.bytes -= written;
    if (written < head.byteLength) {
      queue.chunks[0] = head.subarray(written);
      return;
    }
    queue.chunks.shift();
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

/** Index just past the CRLFCRLF that ends the head, or -1. */
function headEnd(buffer: Uint8Array): number {
  for (let i = 3; i < buffer.byteLength; i += 1) {
    if (
      buffer[i] === 10 &&
      buffer[i - 1] === 13 &&
      buffer[i - 2] === 10 &&
      buffer[i - 3] === 13
    ) {
      return i + 1;
    }
  }
  return -1;
}
