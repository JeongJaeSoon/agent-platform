import { isIP, connect as netConnect, type Socket } from "node:net";
import { Readable } from "node:stream";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  buildQueryString,
  type HttpRequest,
  HttpResponse,
} from "@smithy/core/protocols";
import type { HttpHandlerOptions } from "@smithy/types";

import {
  BodyStallError,
  BoundedNodeHttpHandler,
  type S3RequestBounds,
} from "./s3.ts";

/**
 * An S3 request handler for https endpoints that does its own TLS, so that
 * the ClientHello is one an SNI-checking egress proxy will pass.
 *
 * Why it exists: under Bun 1.3, `fetch` and `node:https` put a GREASE
 * `encrypted_client_hello` extension in every ClientHello, and the egress
 * proxy refuses ECH of any kind because it cannot judge the name it hides
 * (94S-219). `node:tls` does not send it (measured, 94S-254), but Bun's
 * `node:http` ignores both a request's `createConnection` and an agent's,
 * so there is no way to hand it a socket this code opened. What remains is
 * to open the tunnel, the TLS session and the HTTP/1.1 exchange here.
 *
 * Deliberately minimal: one request per connection (`connection: close`), no
 * pooling, no `Expect: 100-continue`. A checkpoint turn makes a handful of
 * requests, so a CONNECT and a handshake each is cheap next to the object it
 * moves. Trigger to add pooling: a measured request rate at which the extra
 * round trips show up in turn latency.
 *
 * The bounds are the ones `BoundedNodeHttpHandler` applies, measured from the
 * same points: `connectionTimeout` until the TLS session is up (proxy dial,
 * CONNECT and handshake included), `requestTimeout` from the call until the
 * response headers, and `bodyIdleMs` on the wire once they are in.
 *
 * A plain http request goes to `BoundedNodeHttpHandler` instead: Bun's
 * `node:http` sends it absolute-form to `HTTP_PROXY` by itself, and there
 * is no ClientHello to get wrong. The choice is per request because the SDK
 * picks the endpoint, from its config or from `AWS_ENDPOINT_URL`.
 */
export class TlsTunnelHttpHandler {
  readonly metadata = { handlerProtocol: "http/1.1" };
  #bounds: S3RequestBounds;
  readonly #live = new Set<Socket>();
  readonly #plain: BoundedNodeHttpHandler;
  readonly #route: EgressRoute;

  constructor(bounds: S3RequestBounds, route: EgressRoute) {
    this.#bounds = bounds;
    this.#plain = new BoundedNodeHttpHandler(bounds);
    this.#route = route;
  }

  destroy(): void {
    for (const socket of this.#live) socket.destroy();
    this.#live.clear();
    this.#plain.destroy();
  }

  httpHandlerConfigs(): S3RequestBounds {
    return this.#bounds;
  }

  updateHttpClientConfig(key: keyof S3RequestBounds, value: unknown): void {
    if (!(key in this.#bounds)) return;
    this.#bounds = { ...this.#bounds, [key]: value };
    // The node handler has every bound but the body idle one, which it
    // reads from its own constructor argument.
    if (key !== "bodyIdleMs") {
      this.#plain.updateHttpClientConfig(key, value as never);
    }
  }

  handle(
    request: HttpRequest,
    options: HttpHandlerOptions = {},
  ): Promise<{ response: HttpResponse }> {
    if (request.protocol === "http:") {
      return this.#plain.handle(request, options);
    }
    return new Promise((resolve, reject) => {
      new Exchange(request, options, this.#bounds, this.#route, this.#live, {
        reject,
        resolve,
      }).start();
    });
  }
}

/**
 * Where an https connection goes: through the CONNECT proxy unless the host
 * is exempt. Read from the environment by {@link egressRouteFromEnv}, the
 * same variables Bun's own clients honour.
 */
export type EgressRoute = {
  /**
   * Trust anchors in place of the runtime's own. Only tests set this; a
   * deployment adds its CA with `NODE_EXTRA_CA_CERTS`, which `node:tls`
   * honours.
   */
  readonly ca?: string;
  readonly noProxy: readonly string[];
  readonly proxy?: URL;
};

export type EgressRouteEnvironment = {
  HTTPS_PROXY?: string | undefined;
  NO_PROXY?: string | undefined;
  https_proxy?: string | undefined;
  no_proxy?: string | undefined;
};

/**
 * Lower case first, as curl and undici read them. Only a plain `http://`
 * proxy is supported: that is what the egress proxy is, and a TLS or
 * authenticating proxy would be one more protocol spoken here for nobody.
 */
export function egressRouteFromEnv(
  environment: EgressRouteEnvironment,
): EgressRoute {
  const noProxy = (environment.no_proxy ?? environment.NO_PROXY ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  const value = (environment.https_proxy ?? environment.HTTPS_PROXY)?.trim();
  if (!value) return { noProxy };
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch {
    // Not quoted: a value that failed to parse may still hold a credential.
    throw new Error("HTTPS_PROXY is not a URL");
  }
  if (proxy.username !== "" || proxy.password !== "") {
    throw new Error("HTTPS_PROXY must not carry credentials");
  }
  if (proxy.protocol !== "http:") {
    throw new Error(`HTTPS_PROXY ${value} must be an http:// proxy`);
  }
  if (proxy.pathname !== "/" || proxy.search !== "" || proxy.hash !== "") {
    throw new Error(`HTTPS_PROXY ${value} must name only a host and port`);
  }
  return { noProxy, proxy };
}

/** `NO_PROXY` as curl reads it: `*`, a host, a domain suffix, or host:port. */
export function bypassesProxy(
  host: string,
  port: number,
  noProxy: readonly string[],
): boolean {
  const name = unbracket(host).toLowerCase();
  return noProxy.some((raw) => {
    if (raw === "*") return true;
    let entry = raw;
    const withPort = /^(.+):(\d+)$/.exec(entry);
    if (withPort && isIP(entry) !== 6) {
      if (Number(withPort[2]) !== port) return false;
      entry = withPort[1] as string;
    }
    entry = unbracket(entry).replace(/^\*?\./, "");
    return name === entry || name.endsWith(`.${entry}`);
  });
}

/** The DOM-shaped signal; the SDK's types also allow a bare `onabort` one. */
type ListenableSignal = {
  addEventListener(
    type: "abort",
    listener: () => void,
    options: { once: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

type Settle = {
  reject: (error: Error) => void;
  resolve: (value: { response: HttpResponse }) => void;
};

/** How much of a response head or CONNECT reply is read before giving up. */
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_CHUNK_LINE_BYTES = 4 * 1024;
/**
 * Headers this handler decides for itself. `expect` is among them because
 * `100-continue` is not implemented; SigV4 never signs it.
 */
const OWN_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** One request over one connection, from the dial to the last body byte. */
class Exchange {
  #body: ResponseBody | undefined;
  #connectTimer: ReturnType<typeof setTimeout> | undefined;
  #decoder: BodyDecoder | undefined;
  #detachAbort: () => void = () => undefined;
  #headBytes = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #requestTimer: ReturnType<typeof setTimeout> | undefined;
  #settled = false;
  readonly #sockets: Socket[] = [];
  #tls: TLSSocket | undefined;
  readonly #host: string;
  readonly #port: number;

  constructor(
    private readonly request: HttpRequest,
    private readonly options: HttpHandlerOptions,
    private readonly bounds: S3RequestBounds,
    private readonly route: EgressRoute,
    private readonly live: Set<Socket>,
    private readonly settle: Settle,
  ) {
    this.#host = unbracket(request.hostname);
    this.#port = request.port ?? 443;
  }

  start(): void {
    const { abortSignal } = this.options;
    if (this.request.protocol !== "https:") {
      this.#fail(
        new Error(
          `TlsTunnelHttpHandler speaks only https, not ${this.request.protocol}`,
        ),
      );
      return;
    }
    // Measured on Bun 1.3: `node:tls` given an IP host and no servername
    // sends SNI "localhost" and verifies the certificate for "localhost";
    // given the IP as servername it sends that as SNI, which RFC 6066 forbids
    // and the egress proxy refuses for an IP authority. Neither is safe, so
    // an address is refused. Deliberately minimal; trigger: an https object
    // store that can only be addressed by IP.
    if (isIP(this.#host) !== 0) {
      this.#fail(
        new Error(
          `S3 https endpoint must be a DNS name, not the address ${this.#host}`,
        ),
      );
      return;
    }
    if (abortSignal?.aborted) {
      this.#fail(abortError(abortSignal));
      return;
    }
    let body: Uint8Array | undefined;
    let head: string;
    try {
      body = requestBytes(this.request.body);
      head = requestHead(this.request, this.#host, this.#port, body);
    } catch (error) {
      this.#fail(error as Error);
      return;
    }
    if (abortSignal) {
      // Like `node:http`, an abort after the headers still ends the body.
      const onAbort = () => this.#abort(abortError(abortSignal));
      const signal = abortSignal as Partial<ListenableSignal>;
      if (signal.addEventListener && signal.removeEventListener) {
        const { removeEventListener } = signal as ListenableSignal;
        signal.addEventListener("abort", onAbort, { once: true });
        this.#detachAbort = () =>
          removeEventListener.call(signal, "abort", onAbort);
      } else {
        abortSignal.onabort = onAbort;
        this.#detachAbort = () => {
          abortSignal.onabort = null;
        };
      }
    }
    const { connectionTimeout } = this.bounds;
    const requestTimeout =
      this.options.requestTimeout ?? this.bounds.requestTimeout;
    if (connectionTimeout > 0) {
      this.#connectTimer = setTimeout(
        () =>
          this.#fail(
            timeoutError(
              `S3 connection was not established within ${connectionTimeout}ms`,
            ),
          ),
        connectionTimeout,
      );
    }
    if (requestTimeout > 0) {
      this.#requestTimer = setTimeout(
        () =>
          this.#fail(
            timeoutError(
              `S3 response headers did not arrive within ${requestTimeout}ms`,
            ),
          ),
        requestTimeout,
      );
    }
    const onSecure = () => {
      clearTimeout(this.#connectTimer);
      this.#exchange(head, body);
    };
    const proxy = this.route.proxy;
    if (proxy && !bypassesProxy(this.#host, this.#port, this.route.noProxy)) {
      this.#tunnel(proxy, onSecure);
    } else {
      this.#secure(undefined, onSecure);
    }
  }

  /** Dials the proxy and asks it for a tunnel to the endpoint. */
  #tunnel(proxy: URL, onSecure: () => void): void {
    const socket = netConnect({
      host: unbracket(proxy.hostname),
      port: Number(proxy.port || 80),
    });
    this.#track(socket);
    const authority = `${isIP(this.#host) === 6 ? `[${this.#host}]` : this.#host}:${this.#port}`;
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`,
      );
    });
    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.byteLength > MAX_HEAD_BYTES) {
          this.#fail(new Error("proxy reply to CONNECT exceeded 64 KiB"));
        }
        return;
      }
      socket.off("data", onData);
      const statusLine = buffered.subarray(0, buffered.indexOf("\r\n"));
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(
        statusLine.toString("latin1"),
      )?.[1];
      if (status !== "200") {
        this.#fail(
          proxyRefusal(
            `proxy answered CONNECT ${authority} with ${printable(statusLine)}`,
            Number(status),
          ),
        );
        return;
      }
      // The server speaks only after our ClientHello, so anything already
      // here came from the proxy, and TLS would take it for the server's.
      if (buffered.byteLength > end + 4) {
        this.#fail(new Error("proxy sent bytes after its CONNECT reply"));
        return;
      }
      this.#secure(socket, onSecure);
    };
    socket.on("data", onData);
  }

  /**
   * TLS to the endpoint, over the tunnel if there is one: the endpoint's
   * name is both the SNI the proxy checks against the CONNECT authority and
   * the name the certificate is verified for.
   */
  #secure(tunnel: Socket | undefined, onSecure: () => void): void {
    const tls = tlsConnect({
      ...(tunnel ? { socket: tunnel } : { port: this.#port }),
      host: this.#host,
      servername: this.#host,
      ...(this.route.ca ? { ca: this.route.ca } : {}),
    });
    this.#tls = tls;
    this.#track(tls);
    tls.once("secureConnect", onSecure);
  }

  #exchange(head: string, body: Uint8Array | undefined): void {
    const tls = this.#tls as TLSSocket;
    let buffered: Buffer = Buffer.alloc(0);
    tls.on("data", (chunk: Buffer) => {
      if (this.#decoder) {
        this.#armIdle();
        this.#decoder.write(chunk);
        return;
      }
      buffered = buffered.byteLength ? Buffer.concat([buffered, chunk]) : chunk;
      buffered = this.#readHead(buffered);
    });
    tls.once("end", () => this.#decoder?.end());
    // Written in one go and read concurrently: a peer that answers early —
    // a 412 to a conditional PUT — is heard while the upload is still
    // draining, and its response is what `send()` gets.
    tls.write(head);
    if (body !== undefined && body.byteLength > 0) tls.write(body);
  }

  /**
   * Returns what is left to buffer once any complete heads are consumed. The
   * byte cap covers every head of the response, informational ones included,
   * so a peer cannot hold the exchange open with an endless run of 1xx.
   */
  #readHead(buffered: Buffer): Buffer {
    let rest = buffered;
    for (;;) {
      const end = rest.indexOf("\r\n\r\n");
      const within = MAX_HEAD_BYTES - this.#headBytes;
      if (end < 0 || end + 4 > within) {
        if (end >= 0 || rest.byteLength > within) {
          this.#fail(new Error("S3 response head exceeded 64 KiB"));
          return Buffer.alloc(0);
        }
        return rest;
      }
      this.#headBytes += end + 4;
      let head: ResponseHead;
      try {
        head = parseResponseHead(rest.subarray(0, end).toString("latin1"));
      } catch (error) {
        this.#fail(error as Error);
        return Buffer.alloc(0);
      }
      rest = rest.subarray(end + 4);
      if (head.statusCode === 101) {
        this.#fail(new Error("S3 endpoint switched protocols"));
        return Buffer.alloc(0);
      }
      // 100 Continue and 103 Early Hints are informational: a final
      // response follows on the same connection.
      if (head.statusCode < 200) continue;
      this.#respond(head, rest);
      return Buffer.alloc(0);
    }
  }

  #respond(head: ResponseHead, rest: Buffer): void {
    const tls = this.#tls as TLSSocket;
    const body = new ResponseBody(tls, () => this.#armIdle());
    this.#body = body;
    body.once("close", () => {
      clearTimeout(this.#idleTimer);
      this.#detachAbort();
    });
    // Once the body is destroyed — by the reader, a stall or an abort — the
    // decoder has nothing left to tell it, and must not replace the error
    // it was destroyed with.
    const decoder = decoderFor(this.request.method, head, {
      done: () => {
        clearTimeout(this.#idleTimer);
        if (!body.destroyed) body.push(null);
        // Everything is in the body's buffer; the connection is spent.
        tls.destroy();
      },
      fail: (error) => {
        clearTimeout(this.#idleTimer);
        body.destroy(error);
      },
      push: (bytes) => {
        if (body.destroyed) return;
        if (!body.push(bytes)) {
          // The reader is behind, not the peer: no idle clock while paused.
          clearTimeout(this.#idleTimer);
          tls.pause();
        }
      },
    });
    this.#decoder = decoder;
    this.#succeed(
      new HttpResponse({
        body,
        headers: head.headers,
        reason: head.reason,
        statusCode: head.statusCode,
      }),
    );
    this.#armIdle();
    if (rest.byteLength > 0) decoder.write(rest);
    decoder.start();
  }

  /**
   * The body idle bound (94S-223): once the headers are in, the SDK may read
   * the body inside `send()` — an error document, a list page — where no
   * request timeout reaches it. Re-armed by every byte off the wire.
   */
  #armIdle(): void {
    clearTimeout(this.#idleTimer);
    if (this.#decoder?.finished !== false) return;
    const idleMs = this.bounds.bodyIdleMs;
    this.#idleTimer = setTimeout(() => {
      if (this.#decoder?.finished !== false) return;
      this.#abort(
        new BodyStallError(
          `S3 response body delivered nothing for ${idleMs}ms`,
        ),
      );
    }, idleMs);
  }

  #track(socket: Socket): void {
    this.#sockets.push(socket);
    this.live.add(socket);
    socket.on("error", (error) => this.#abort(error));
    socket.once("close", () => {
      this.live.delete(socket);
      if (!this.#settled) this.#fail(resetError("socket hang up"));
      else this.#decoder?.end();
    });
  }

  /**
   * Ends the exchange wherever it is: a rejection before the headers, a
   * destroyed body after them. A body that is already complete is left
   * alone; its bytes are all in hand.
   */
  #abort(error: Error): void {
    if (!this.#settled) {
      this.#fail(error);
      return;
    }
    if (this.#decoder?.finished === false) this.#body?.destroy(error);
    for (const socket of this.#sockets) socket.destroy();
  }

  #fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimers();
    this.#detachAbort();
    for (const socket of this.#sockets) socket.destroy();
    this.settle.reject(error);
  }

  #succeed(response: HttpResponse): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimers();
    this.settle.resolve({ response });
  }

  #clearTimers(): void {
    clearTimeout(this.#connectTimer);
    clearTimeout(this.#requestTimer);
  }
}

/**
 * The response body the SDK reads. Destroying it drops the connection, and
 * like a `node:http` response it does not throw an error nobody listens for.
 */
class ResponseBody extends Readable {
  constructor(
    readonly socket: TLSSocket,
    private readonly onDemand: () => void,
  ) {
    super();
  }

  override _read(): void {
    if (this.socket.isPaused()) {
      this.socket.resume();
      this.onDemand();
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.socket.destroy();
    callback(this.listenerCount("error") > 0 ? error : null);
  }
}

type ResponseHead = {
  headers: Record<string, string>;
  reason: string;
  statusCode: number;
};

function parseResponseHead(text: string): ResponseHead {
  const [statusLine = "", ...lines] = text.split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!status) {
    throw new Error(
      `S3 endpoint sent a malformed status line: ${printable(Buffer.from(statusLine, "latin1"))}`,
    );
  }
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    if (colon <= 0 || !HEADER_NAME.test(name)) {
      throw new Error("S3 endpoint sent a malformed header line");
    }
    const key = name.toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }
  return {
    headers,
    reason: status[2] ?? "",
    statusCode: Number(status[1]),
  };
}

type BodySink = {
  done: () => void;
  fail: (error: Error) => void;
  push: (bytes: Buffer) => void;
};

type BodyDecoder = {
  /** The stream ended: complete for a close-delimited body, short otherwise. */
  end(): void;
  readonly finished: boolean;
  /** Called once the head is handled, so an empty body ends at once. */
  start(): void;
  write(chunk: Buffer): void;
};

/** RFC 9112 §6.3, in the order it gives. */
function decoderFor(
  method: string,
  head: ResponseHead,
  sink: BodySink,
): BodyDecoder {
  if (
    method.toUpperCase() === "HEAD" ||
    head.statusCode === 204 ||
    head.statusCode === 304
  ) {
    return lengthDecoder(0, sink);
  }
  const transferEncoding = head.headers["transfer-encoding"];
  const contentLength = head.headers["content-length"];
  if (transferEncoding !== undefined && contentLength !== undefined) {
    // RFC 9112 lets transfer-encoding win, but a peer that sends both is
    // either broken or smuggling; neither answer is one to trust.
    return failedDecoder(
      new Error("S3 endpoint sent both transfer-encoding and content-length"),
      sink,
    );
  }
  if (transferEncoding !== undefined) {
    const codings = transferEncoding.toLowerCase().split(",");
    return codings.at(-1)?.trim() === "chunked"
      ? chunkedDecoder(sink)
      : closeDecoder(sink);
  }
  if (contentLength !== undefined) {
    const values = new Set(contentLength.split(",").map((v) => v.trim()));
    const [only] = values;
    if (values.size !== 1 || only === undefined || !/^\d{1,15}$/.test(only)) {
      return failedDecoder(
        new Error(
          `S3 endpoint sent an invalid content-length: ${contentLength}`,
        ),
        sink,
      );
    }
    return lengthDecoder(Number(only), sink);
  }
  return closeDecoder(sink);
}

function lengthDecoder(length: number, sink: BodySink): BodyDecoder {
  let remaining = length;
  let finished = false;
  return {
    end() {
      if (finished) return;
      finished = true;
      sink.fail(
        resetError(
          `S3 response body ended ${remaining} bytes short of its content-length`,
        ),
      );
    },
    get finished() {
      return finished;
    },
    start() {
      if (remaining > 0 || finished) return;
      finished = true;
      sink.done();
    },
    write(chunk) {
      if (finished) return;
      const take = chunk.subarray(0, remaining);
      remaining -= take.byteLength;
      if (take.byteLength > 0) sink.push(take);
      if (remaining === 0) {
        finished = true;
        sink.done();
      }
    },
  };
}

function closeDecoder(sink: BodySink): BodyDecoder {
  let finished = false;
  return {
    end() {
      if (finished) return;
      finished = true;
      sink.done();
    },
    get finished() {
      return finished;
    },
    start() {},
    write(chunk) {
      if (!finished) sink.push(chunk);
    },
  };
}

function failedDecoder(error: Error, sink: BodySink): BodyDecoder {
  let finished = false;
  return {
    end() {},
    get finished() {
      return finished;
    },
    start() {
      finished = true;
      sink.fail(error);
    },
    write() {},
  };
}

function chunkedDecoder(sink: BodySink): BodyDecoder {
  let state: "size" | "data" | "data-end" | "trailer" = "size";
  let line: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let trailerBytes = 0;
  let finished = false;
  const fail = (message: string) => {
    finished = true;
    sink.fail(
      new Error(`S3 endpoint sent a malformed chunked body: ${message}`),
    );
  };
  return {
    end() {
      if (finished) return;
      finished = true;
      sink.fail(resetError("S3 response body ended inside a chunked body"));
    },
    get finished() {
      return finished;
    },
    start() {},
    write(chunk) {
      let at = 0;
      while (!finished && at < chunk.byteLength) {
        if (state === "data") {
          const take = chunk.subarray(at, at + remaining);
          remaining -= take.byteLength;
          at += take.byteLength;
          sink.push(take);
          if (remaining === 0) state = "data-end";
          continue;
        }
        const newline = chunk.indexOf(10, at);
        const piece = chunk.subarray(
          at,
          newline < 0 ? chunk.byteLength : newline + 1,
        );
        at += piece.byteLength;
        line = line.byteLength ? Buffer.concat([line, piece]) : piece;
        const cap = state === "trailer" ? MAX_HEAD_BYTES : MAX_CHUNK_LINE_BYTES;
        if (line.byteLength > cap) return fail("line too long");
        if (newline < 0) continue;
        if (line.byteLength < 2 || line[line.byteLength - 2] !== 13) {
          return fail("line not ended by CRLF");
        }
        const text = line.subarray(0, -2).toString("latin1");
        line = Buffer.alloc(0);
        if (state === "data-end") {
          if (text !== "") return fail("chunk data overran its size");
          state = "size";
        } else if (state === "size") {
          const size = text.split(";")[0]?.trim() ?? "";
          if (!/^[0-9a-fA-F]{1,12}$/.test(size)) {
            return fail(`bad chunk size ${JSON.stringify(size)}`);
          }
          remaining = Number.parseInt(size, 16);
          state = remaining === 0 ? "trailer" : "data";
        } else {
          trailerBytes += text.length + 2;
          if (trailerBytes > MAX_HEAD_BYTES) return fail("trailer too long");
          if (text === "") {
            finished = true;
            sink.done();
          }
        }
      }
    },
  };
}

/**
 * What the request carries. Bytes only: every PutObject this repo makes has
 * a `Uint8Array` body, for which the SDK sets `content-length` and a CRC32
 * header and never switches to `aws-chunked`. Deliberately minimal: a
 * stream body is refused rather than sent chunked, since it would also need
 * a replayable-body story for retries. Trigger: a caller that uploads a
 * stream through the worker.
 */
function requestBytes(body: unknown): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error(
    "TlsTunnelHttpHandler sends only byte bodies; this request body is a stream or an unknown type",
  );
}

/**
 * The request line and headers, signed values untouched. Framing is this
 * handler's: `content-length` is the byte count it will write.
 */
function requestHead(
  request: HttpRequest,
  host: string,
  port: number,
  body: Uint8Array | undefined,
): string {
  const query = request.query ? buildQueryString(request.query) : "";
  const target = `${request.path || "/"}${query ? `?${query}` : ""}`;
  if (/[\s\0]/.test(target)) {
    throw new Error("S3 request path contains whitespace or NUL");
  }
  const lines = [`${request.method.toUpperCase()} ${target} HTTP/1.1`];
  let hasHost = false;
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HEADER_NAME.test(name) || /[\r\n\0]/.test(value)) {
      throw new Error(`S3 request header ${JSON.stringify(name)} is invalid`);
    }
    const key = name.toLowerCase();
    if (key === "transfer-encoding") {
      throw new Error(
        "TlsTunnelHttpHandler does not send transfer-encoded requests",
      );
    }
    if (OWN_HEADERS.has(key)) continue;
    if (key === "host") hasHost = true;
    lines.push(`${name}: ${value}`);
  }
  if (!hasHost) {
    const name = isIP(host) === 6 ? `[${host}]` : host;
    lines.push(`host: ${port === 443 ? name : `${name}:${port}`}`);
  }
  if (
    body !== undefined ||
    ["PATCH", "POST", "PUT"].includes(request.method.toUpperCase())
  ) {
    lines.push(`content-length: ${body?.byteLength ?? 0}`);
  }
  lines.push("connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function printable(bytes: Buffer): string {
  return JSON.stringify(bytes.subarray(0, 200).toString("latin1"));
}

/** Named and coded the way the SDK's retry strategy counts as transient. */
function timeoutError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "ETIMEDOUT",
    name: "TimeoutError",
  });
}

function resetError(message: string): Error {
  return Object.assign(new Error(message), { code: "ECONNRESET" });
}

/**
 * A refusal the proxy decided (403, 407) is policy and final; one it could
 * not carry out (502–504: the upstream did not answer) is worth another
 * attempt, which the SDK reads from the `$retryable` trait.
 */
function proxyRefusal(message: string, status: number): Error {
  const error = Object.assign(new Error(message), {
    name: "ProxyConnectError",
    status,
  });
  return status >= 502 && status <= 504
    ? Object.assign(error, { $retryable: {} })
    : error;
}

function abortError(
  signal: NonNullable<HttpHandlerOptions["abortSignal"]>,
): Error {
  const reason = (signal as { reason?: unknown }).reason;
  const error = new Error(
    "Request aborted",
    reason instanceof Error ? { cause: reason } : undefined,
  );
  error.name = "AbortError";
  return error;
}
