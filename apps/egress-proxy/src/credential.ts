import { isIP } from "node:net";
import type { Server } from "bun";
import { createProxyLogger, type ProxyLogger } from "./logger.ts";
import {
  classifyAddress,
  decideEgress,
  type EgressPolicy,
  type EgressResolver,
  normalizeHost,
} from "./policy.ts";
import { systemResolver } from "./proxy.ts";
import { type UpstreamBody, upstreamExchange } from "./upstream-http.ts";

/**
 * The proxy's credential routes (94S-252): the one place a worker's request
 * picks up a provider key or a repository login, which the worker itself
 * never holds. The worker presents an attempt-scoped token; the gateway's
 * authorizer says what it stands for right now and hands back the upstream
 * and the credential; the request goes there with the credential injected
 * and the token stripped.
 *
 * A listener of its own rather than a mode of the forward proxy: this one
 * has to understand each HTTP exchange — one request, its framing, its
 * headers — where the forward proxy deliberately only pipes bytes, and a
 * second request pipelined behind an authorized one must never reach the
 * upstream on its coat-tails. Bun's HTTP server does the framing. Plaintext
 * on the worker's side is fine: only the worker and this proxy sit on a
 * worker's network (94S-216).
 *
 * Only the operations a session needs are routed — the Messages API, and
 * the read half of git's smart HTTP — so a leaked token buys at most that,
 * for as long as its attempt still owns its session.
 *
 * The object store route (94S-251) is the one way a worker reaches its
 * objects: the store itself is not on its allowlist. The worker's S3 client
 * sends ordinary S3 requests here with its token as the access key id; the
 * authorizer judges each one against the session's prefix and signs it with
 * the API's key, and only what it signed — its target, its headers — goes
 * upstream. Nothing of the worker's request travels but the body.
 */

export const DEFAULT_CREDENTIAL_PORT = 3129;
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 10_000;
/**
 * One exchange, start to last byte. A clone of a large repository is one
 * exchange (the pack streams back on the upload-pack POST), and the worker
 * gives a clone 30 minutes, so this sits just above it.
 */
const DEFAULT_EXCHANGE_TIMEOUT_MS = 35 * 60_000;
const DEFAULT_MAX_EXCHANGES = 256;
/**
 * How often an open exchange asks again whether its grant still stands. A
 * revoked token stops new exchanges at once; one already streaming learns
 * of it here, so an attempt that lost its lease keeps an upstream call at
 * most this long rather than to the exchange deadline.
 */
const DEFAULT_REGRANT_INTERVAL_MS = 30_000;
/**
 * How long an open exchange may go without a fresh grant while the
 * authorizer cannot be asked. A blip passes; an outage long enough to hide
 * the attempt's end does not.
 */
const DEFAULT_REGRANT_GRACE_MS = 90_000;
const DEFAULT_MAX_EXCHANGES_PER_CLIENT = 32;
/** An error body bigger than this is not relayed at all. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Above the Messages API's own request limit. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
/**
 * Twice the control plane's workspace bundle ceiling (256 MiB,
 * `DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES`), the largest object a worker writes.
 * Streamed, never held: it is the listener's cap, not a buffer.
 */
const MAX_OBJECT_BODY_BYTES = 512 * 1024 * 1024;
/**
 * Bun's idle clock before a request is authorized: a client that opens a
 * connection and sends nothing is dropped. An authorized exchange runs on
 * the exchange deadline instead, since a non-streaming Messages call can
 * sit silent for minutes.
 */
const UNAUTHORIZED_IDLE_SECONDS = 30;

export type EgressPurpose = "provider" | "repository" | "object_store";

export type CredentialRoute = {
  purpose: EgressPurpose;
  /** Path and query appended to the upstream's base. */
  path: string;
  search: string;
};

const PROVIDER_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
// Claude Code asks for the beta surface with `?beta=true`; nothing else.
const PROVIDER_QUERIES = new Set(["", "?beta=true"]);

const OBJECT_STORE_PREFIX = "/object-store";

/** The exact operations routed, or null for everything else. */
export function routeOf(
  method: string,
  pathname: string,
  search: string,
): CredentialRoute | null {
  // Every object store request is the authorizer's to judge, so a refused
  // delete answers like S3 would, not as a missing route.
  if (pathname.startsWith(`${OBJECT_STORE_PREFIX}/`)) {
    return {
      purpose: "object_store",
      path: pathname.slice(OBJECT_STORE_PREFIX.length),
      search,
    };
  }
  if (pathname.startsWith("/provider/")) {
    const path = pathname.slice("/provider".length);
    if (
      method === "POST" &&
      PROVIDER_PATHS.has(path) &&
      PROVIDER_QUERIES.has(search)
    ) {
      return { purpose: "provider", path, search };
    }
    return null;
  }
  // Only upload-pack, the read half: receive-pack (a push) has no route.
  if (
    method === "GET" &&
    pathname === "/repository/info/refs" &&
    search === "?service=git-upload-pack"
  ) {
    return { purpose: "repository", path: "/info/refs", search };
  }
  if (
    method === "POST" &&
    pathname === "/repository/git-upload-pack" &&
    search === ""
  ) {
    return { purpose: "repository", path: "/git-upload-pack", search };
  }
  return null;
}

const BEARER = /^Bearer ([!-~]+)$/;
/** An S3 client's header signature; the access key id is the token. */
const SIGV4 = /^AWS4-HMAC-SHA256 Credential=([A-Za-z0-9_-]+)\//;

/**
 * The one token the request carries. Two carriers — an `x-api-key` beside an
 * `authorization`, even equal ones — are refused: which one an upstream
 * would have read is exactly the ambiguity to avoid.
 */
export function tokenOf(
  headers: Headers,
  purpose: EgressPurpose,
): string | null {
  const apiKey = headers.get("x-api-key");
  const authorization = headers.get("authorization");
  if (purpose === "object_store") {
    if (apiKey !== null || authorization === null) return null;
    return SIGV4.exec(authorization)?.[1] ?? null;
  }
  if (apiKey !== null && authorization !== null) return null;
  if (authorization !== null) return BEARER.exec(authorization)?.[1] ?? null;
  if (apiKey !== null && purpose === "provider" && /^[!-~]+$/.test(apiKey)) {
    return apiKey;
  }
  return null;
}

export type EgressGrant = {
  sessionId: string;
  attemptId: string;
  upstream: URL;
  headers: Array<[string, string]>;
  /**
   * The object store route's request line as signed, path and query; null
   * for the other routes, whose path comes from the route itself.
   */
  target: string | null;
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const REQUEST_TARGET = /^\/[!-~]*$/;

/**
 * The authorizer's answer, checked field by field: the proxy has no schema
 * library, and it is about to put these bytes on the wire with a credential
 * in them.
 */
export function parseGrant(body: unknown): EgressGrant | null {
  if (typeof body !== "object" || body === null) return null;
  const { session_id, attempt_id, upstream } = body as Record<string, unknown>;
  if (typeof session_id !== "string" || typeof attempt_id !== "string") {
    return null;
  }
  if (typeof upstream !== "object" || upstream === null) return null;
  const { url, headers, target } = upstream as Record<string, unknown>;
  if (typeof url !== "string" || !Array.isArray(headers)) return null;
  if (
    target !== undefined &&
    (typeof target !== "string" || !REQUEST_TARGET.test(target))
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const pairs: Array<[string, string]> = [];
  for (const entry of headers) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !HEADER_NAME.test(entry[0]) ||
      !HEADER_VALUE.test(entry[1])
    ) {
      return null;
    }
    pairs.push([entry[0].toLowerCase(), entry[1]]);
  }
  return {
    sessionId: session_id,
    attemptId: attempt_id,
    upstream: parsed,
    headers: pairs,
    target: target ?? null,
  };
}

/**
 * What of an S3 request the authorizer is shown, to judge and sign: the
 * standard headers that change what S3 does, and every `x-amz-` header but
 * the ones a signature is made of, which it replaces. The rest (the SDK's
 * user agent and invocation ids) is dropped. The authorizer refuses any
 * header it does not know, so a copy source or an Object Lock header is a
 * refusal, not a header quietly lost on the way.
 */
const OBJECT_REQUEST_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-md5",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "range",
]);
const SIGNATURE_HEADERS = new Set([
  "x-amz-content-sha256",
  "x-amz-date",
  "x-amz-security-token",
  "x-amz-user-agent",
]);

export type ObjectRequest = {
  method: string;
  target: string;
  headers: Array<[string, string]>;
};

export function objectRequestOf(
  method: string,
  target: string,
  incoming: Headers,
): ObjectRequest {
  const headers: Array<[string, string]> = [];
  incoming.forEach((value, name) => {
    if (
      OBJECT_REQUEST_HEADERS.has(name) ||
      (name.startsWith("x-amz-") && !SIGNATURE_HEADERS.has(name))
    ) {
      headers.push([name, value]);
    }
  });
  return { method, target, headers };
}

/**
 * The credentials in an object store grant, for the echo checks: the API's
 * access key id inside the signature, and a session token if it signs with
 * one. The rest of what it adds (a date, a length, a signature good for one
 * request) is not worth withholding a response over.
 */
function objectStoreSecrets(grant: EgressGrant): string[] {
  const found: string[] = [];
  for (const [name, value] of grant.headers) {
    if (name === "x-amz-security-token") found.push(value);
    if (name === "authorization") {
      const keyId = /Credential=([^/,\s]+)\//.exec(value)?.[1];
      if (keyId !== undefined) found.push(keyId);
    }
  }
  return found;
}

/** Headers that describe this hop, or that this proxy sets itself. */
const DROPPED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "connection",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function nominated(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
}

export function upstreamRequestHeaders(
  incoming: Headers,
  grant: EgressGrant,
): Headers {
  const byConnection = nominated(incoming);
  const outgoing = new Headers();
  incoming.forEach((value, name) => {
    if (DROPPED_REQUEST_HEADERS.has(name) || byConnection.has(name)) return;
    outgoing.append(name, value);
  });
  outgoing.set("host", grant.upstream.host);
  // Identity so an error body can be checked for the credential below; a
  // compressed one could carry it unseen.
  outgoing.set("accept-encoding", "identity");
  for (const [name, value] of grant.headers) outgoing.set(name, value);
  return outgoing;
}

/**
 * A header that echoes the injected credential, in its value or its name
 * (which arrives lowercased), is dropped, not relayed.
 */
export function responseHeaders(
  incoming: Headers,
  secrets: readonly string[],
): Headers {
  const byConnection = nominated(incoming);
  const outgoing = new Headers();
  incoming.forEach((value, name) => {
    if (DROPPED_RESPONSE_HEADERS.has(name) || byConnection.has(name)) return;
    if (
      secrets.some(
        (secret) =>
          value.includes(secret) || name.includes(secret.toLowerCase()),
      )
    ) {
      return;
    }
    outgoing.append(name, value);
  });
  return outgoing;
}

/**
 * Shortest injected value a streamed body is checked for. A pack file is
 * arbitrary bytes, and a four-byte password would turn up in a large one by
 * chance; at eight the odds are nil. A catalog credential shorter than that
 * is still kept out of headers and error bodies, just not out of a stream.
 */
const MIN_STREAMED_SECRET_BYTES = 8;

/** Length of the longest tail of `window` that some needle starts with. */
function pendingPrefix(window: Buffer, needles: readonly Buffer[]): number {
  let longest = 0;
  for (const needle of needles) {
    const most = Math.min(needle.byteLength - 1, window.byteLength);
    for (let size = most; size > longest; size--) {
      if (
        window
          .subarray(window.byteLength - size)
          .equals(needle.subarray(0, size))
      ) {
        longest = size;
        break;
      }
    }
  }
  return longest;
}

/**
 * Passes a successful body through unless it contains the credential: the
 * tail that could be the start of one is held back until the next chunk
 * shows it is not, and a match errors the stream before any of its bytes
 * are written. The worker sees a broken response, never the value.
 */
export function secretGuard(
  secrets: readonly string[],
  onMatch: () => void = () => {},
): TransformStream<Uint8Array, Uint8Array> {
  const needles = secrets
    .map((secret) => Buffer.from(secret, "utf8"))
    .filter((needle) => needle.byteLength >= MIN_STREAMED_SECRET_BYTES);
  let carry = Buffer.alloc(0);
  return new TransformStream({
    transform(chunk, controller) {
      if (needles.length === 0) {
        controller.enqueue(chunk);
        return;
      }
      const window = Buffer.concat([carry, chunk]);
      if (needles.some((needle) => window.includes(needle))) {
        onMatch();
        controller.error(new Error("upstream body echoed the credential"));
        return;
      }
      // Only a tail that could still become a value waits; anything else,
      // like the blank line closing an event, goes out now.
      const cut = window.byteLength - pendingPrefix(window, needles);
      if (cut > 0) controller.enqueue(new Uint8Array(window.subarray(0, cut)));
      carry = window.subarray(cut);
    },
    flush(controller) {
      if (carry.byteLength > 0) controller.enqueue(new Uint8Array(carry));
    },
  });
}

/** Every spelling of the injected credential an upstream might echo. */
export function secretsOf(grant: EgressGrant): string[] {
  const found = new Set<string>();
  for (const [, value] of grant.headers) {
    found.add(value);
    const [scheme, rest] = value.split(" ", 2);
    if (rest === undefined) continue;
    found.add(rest);
    if (scheme?.toLowerCase() === "basic") {
      const decoded = Buffer.from(rest, "base64").toString("utf8");
      found.add(decoded);
      const colon = decoded.indexOf(":");
      if (colon >= 0) found.add(decoded.slice(colon + 1));
    }
  }
  return [...found].filter((secret) => secret.length >= 4);
}

export type AuthorizerClient = {
  url: string;
  token: string;
  timeoutMs?: number;
};

export type CredentialProxyOptions = {
  authorizer: AuthorizerClient;
  /** How long one exchange may take, admission to last response byte. */
  exchangeTimeoutMs?: number;
  hostname?: string;
  logger?: ProxyLogger;
  maxExchanges?: number;
  maxExchangesPerClient?: number;
  policy: EgressPolicy;
  port?: number;
  regrantGraceMs?: number;
  regrantIntervalMs?: number;
  resolve?: EgressResolver;
  /** Roots for https upstreams; tests name a private CA. */
  upstreamCa?: string;
};

export type CredentialProxyServer = {
  readonly port: number;
  stop(): void;
};

type Authorized =
  | { kind: "granted"; grant: EgressGrant }
  | { kind: "refused"; status: number };

export function startCredentialProxy(
  options: CredentialProxyOptions,
): CredentialProxyServer {
  const logger = options.logger ?? createProxyLogger();
  const resolve = options.resolve ?? systemResolver;
  const exchangeTimeoutMs =
    options.exchangeTimeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  const maxExchanges = options.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const regrantIntervalMs =
    options.regrantIntervalMs ?? DEFAULT_REGRANT_INTERVAL_MS;
  const regrantGraceMs = options.regrantGraceMs ?? DEFAULT_REGRANT_GRACE_MS;
  const maxPerClient =
    options.maxExchangesPerClient ?? DEFAULT_MAX_EXCHANGES_PER_CLIENT;
  const authorizeUrl = new URL("/authorize", options.authorizer.url);
  let open = 0;
  const perClient = new Map<string, number>();

  function reply(
    status: number,
    message: string,
    purpose?: EgressPurpose,
  ): Response {
    if (purpose === "object_store") return s3Error(status, message);
    return new Response(`${message}\n`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  async function authorize(
    token: string,
    purpose: EgressPurpose,
    objectRequest?: ObjectRequest,
  ): Promise<Authorized> {
    let response: Response;
    try {
      response = await fetch(authorizeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.authorizer.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          objectRequest === undefined
            ? { token, purpose }
            : { token, purpose, request: objectRequest },
        ),
        redirect: "error",
        signal: AbortSignal.timeout(
          options.authorizer.timeoutMs ?? DEFAULT_AUTHORIZE_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      logger.warn("Egress authorizer unreachable", {
        error: error instanceof Error ? error.name : "error",
      });
      return { kind: "refused", status: 503 };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      // Its reasons stay with it: the worker learns only that it was refused.
      const status = [401, 403, 409].includes(response.status)
        ? response.status
        : 503;
      if (status === 503) {
        logger.warn("Egress authorizer failed", { status: response.status });
      }
      return { kind: "refused", status };
    }
    const grant = parseGrant(await response.json().catch(() => null));
    if (grant === null) {
      logger.error("Egress authorizer answered something unusable", {});
      return { kind: "refused", status: 503 };
    }
    return { kind: "granted", grant };
  }

  async function exchange(
    request: Request,
    route: CredentialRoute,
    grant: EgressGrant,
    client: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const upstream = grant.upstream;
    const host = normalizeHost(upstream.hostname);
    const port =
      upstream.port === ""
        ? upstream.protocol === "https:"
          ? 443
          : 80
        : Number(upstream.port);
    const fields = {
      purpose: route.purpose,
      session_id: grant.sessionId,
      attempt_id: grant.attemptId,
      host,
      port,
      client,
    };
    // The upstream is the catalog's, not the worker's, and it is still held
    // to the same allowlist and address rules as anything a worker asks for.
    const decision = await decideEgress(
      options.policy,
      { host, port },
      resolve,
    );
    if (!decision.allowed) {
      logger.warn("Credential route denied", {
        ...fields,
        reason: decision.reason,
      });
      return reply(403, `egress denied: ${decision.reason}`, route.purpose);
    }
    // A privately listed name may resolve publicly for a worker's own
    // traffic, but a name that carries a login stays inside: an internal git
    // host whose DNS now points outside must not be handed the password.
    const outside = decision.addresses.find(
      (address) => classifyAddress(address) === "public",
    );
    if (decision.scope === "private" && outside !== undefined) {
      logger.warn("Credential route denied", {
        ...fields,
        reason: `${outside} is public, and ${host} is listed as private`,
      });
      return reply(
        403,
        "egress denied: a private upstream resolved publicly",
        route.purpose,
      );
    }
    // The address that was judged, and only it. A POST is never retried
    // against a second address: its body may already have reached the
    // first.
    const address = decision.addresses[0] ?? "";
    // A certificate is checked for a name; an address would have to be
    // checked for itself, which the upstream client does not do. Nothing in
    // the catalog needs it: trigger to add, an https upstream only
    // reachable by IP.
    if (upstream.protocol === "https:" && isIP(host) !== 0) {
      logger.warn("Credential route denied", {
        ...fields,
        reason: "an https upstream must be named, not an address",
      });
      return reply(502, "an https upstream must be named", route.purpose);
    }
    const base = upstream.pathname.replace(/\/$/, "");
    const objectStore = route.purpose === "object_store";
    if (objectStore && grant.target === null) {
      logger.error("Egress authorizer signed no target", fields);
      return reply(502, "the authorizer signed no request", route.purpose);
    }
    let response: Response;
    try {
      const body = objectStore
        ? objectBody(request, grant)
        : // Whole, before the upstream is dialled.
          await readWhole(request.body, signal, MAX_REQUEST_BODY_BYTES);
      response = await upstreamExchange(
        {
          address,
          port,
          tls:
            upstream.protocol === "https:"
              ? {
                  serverName: host,
                  ...(options.upstreamCa === undefined
                    ? {}
                    : { ca: options.upstreamCa }),
                }
              : null,
        },
        {
          method: request.method,
          target: grant.target ?? `${base}${route.path}${route.search}`,
          // Only what the authorizer signed: the worker's own headers are
          // what it was judged on, not what goes upstream.
          headers: objectStore
            ? [
                ["host", upstream.host],
                ["accept-encoding", "identity"],
                ...grant.headers,
              ]
            : [...upstreamRequestHeaders(request.headers, grant)],
          body,
          signal,
        },
      );
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return reply(413, "request body too large", route.purpose);
      }
      logger.warn("Credential route upstream failed", {
        ...fields,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply(502, "upstream connection failed", route.purpose);
    }
    logger.info("Credential route", { ...fields, status: response.status });
    if (response.status >= 300 && response.status < 400) {
      // A followed redirect would carry the credential somewhere the catalog
      // never named, and a relayed one invites the client to.
      await response.body?.cancel();
      return reply(502, "upstream redirected", route.purpose);
    }
    // Every spelling the upstream could echo back to the worker: headers,
    // a success body and an error body are all checked for them.
    const secrets = objectStore ? objectStoreSecrets(grant) : secretsOf(grant);
    const headers = responseHeaders(response.headers, secrets);
    // A head's answer is its length; there is no body to take it from.
    const length = response.headers.get("content-length");
    if (objectStore && request.method === "HEAD" && length !== null) {
      headers.set("content-length", length);
    }
    if (!response.ok) {
      return withheldIfLeaking(response, headers, secrets, route.purpose);
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") {
      // Asked for identity; a body it cannot read is one it cannot vouch for.
      await response.body?.cancel();
      return reply(
        502,
        "upstream answered with an encoded body",
        route.purpose,
      );
    }
    return new Response(
      response.body?.pipeThrough(
        secretGuard(secrets, () =>
          logger.error("Credential route upstream echoed the credential", {
            ...fields,
            status: response.status,
          }),
        ),
      ) ?? null,
      { status: response.status, headers },
    );
  }

  /**
   * An error body is small and read whole, so it can be checked before the
   * worker sees it: an upstream that echoes the credential it was sent
   * (in a 401 explaining which key failed, say) would otherwise hand it to
   * the very process it was kept from.
   */
  async function withheldIfLeaking(
    response: Response,
    headers: Headers,
    secrets: readonly string[],
    purpose: EgressPurpose,
  ): Promise<Response> {
    const encoding = response.headers.get("content-encoding");
    const body = await readAtMost(response, MAX_ERROR_BODY_BYTES);
    const text = body === null ? null : new TextDecoder().decode(body);
    if (
      body === null ||
      text === null ||
      (encoding !== null && encoding.toLowerCase() !== "identity") ||
      secrets.some((secret) => text.includes(secret))
    ) {
      if (purpose === "object_store") {
        const withheld = s3Error(
          response.status,
          "the upstream error was withheld by the egress proxy",
        );
        return new Response(withheld.body, {
          status: response.status,
          headers: withheld.headers,
        });
      }
      headers.delete("content-encoding");
      headers.set("content-type", "application/json");
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: "The upstream error was withheld by the egress proxy",
          },
        }),
        { status: response.status, headers },
      );
    }
    return new Response(body, { status: response.status, headers });
  }

  function admit(client: string): (() => void) | null {
    const mine = perClient.get(client) ?? 0;
    if (open >= maxExchanges || mine >= maxPerClient) return null;
    open += 1;
    perClient.set(client, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open -= 1;
      const left = (perClient.get(client) ?? 1) - 1;
      if (left <= 0) perClient.delete(client);
      else perClient.set(client, left);
    };
  }

  const server: Server<undefined> = Bun.serve({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? DEFAULT_CREDENTIAL_PORT,
    idleTimeout: UNAUTHORIZED_IDLE_SECONDS,
    // The object store's cap; the other routes hold to their own below.
    maxRequestBodySize: MAX_OBJECT_BODY_BYTES,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return reply(200, "ok");
      }
      const route = routeOf(request.method, url.pathname, url.search);
      if (route === null) return reply(404, "no such credential route");
      const token = tokenOf(request.headers, route.purpose);
      if (token === null) {
        return reply(401, "one egress token is required", route.purpose);
      }
      const objectRequest =
        route.purpose === "object_store"
          ? objectRequestOf(
              request.method,
              `${route.path}${route.search}`,
              request.headers,
            )
          : undefined;
      const client = server.requestIP(request)?.address ?? "unknown";
      const admitted = admit(client);
      if (admitted === null) {
        logger.warn("Refusing a credential exchange over the cap", { client });
        return reply(503, "too many exchanges from this client", route.purpose);
      }
      const revocation = new AbortController();
      // Everything that ends an exchange, the wait for a trickled request
      // body included.
      const ends = AbortSignal.any([
        request.signal,
        revocation.signal,
        AbortSignal.timeout(exchangeTimeoutMs),
      ]);
      let regrant: ReturnType<typeof setTimeout> | undefined;
      let ended = false;
      let answered = false;
      // Once answered, an ended exchange frees its slot whatever becomes of
      // the body: one handed back after the worker hung up is pulled once by
      // Bun and then neither read nor cancelled (94S-366). Until then the
      // slot stays held, and `ends` cuts every wait of the exchange short.
      const hungUp = () => {
        if (answered) release();
      };
      const release = () => {
        ended = true;
        clearTimeout(regrant);
        ends.removeEventListener("abort", hungUp);
        admitted();
      };
      ends.addEventListener("abort", hungUp);
      // A definite refusal cuts the exchange at once. An authorizer that
      // cannot answer does only after the grace: a blip must not break
      // every stream in flight, and an outage must not hide an ended grant.
      let grantedAt = performance.now();
      const watchGrant = (grant: EgressGrant) => {
        regrant = setTimeout(async () => {
          const again = await authorize(token, route.purpose, objectRequest);
          if (ended) return;
          if (again.kind === "granted") grantedAt = performance.now();
          const refused = again.kind === "refused" && again.status !== 503;
          const stale = performance.now() - grantedAt >= regrantGraceMs;
          if (refused || stale) {
            logger.warn("Credential exchange cut: its grant ended", {
              purpose: route.purpose,
              session_id: grant.sessionId,
              attempt_id: grant.attemptId,
              status: again.kind === "refused" ? again.status : 200,
              stale,
              client,
            });
            revocation.abort(new Error("egress grant ended"));
            return;
          }
          watchGrant(grant);
        }, regrantIntervalMs);
      };
      try {
        const authorized = await authorize(token, route.purpose, objectRequest);
        if (authorized.kind === "refused") {
          release();
          return reply(
            authorized.status,
            "egress token refused",
            route.purpose,
          );
        }
        // Authorized: from here the exchange deadline bounds it, not the
        // idle clock, which a silent non-streaming call would trip.
        server.timeout(request, 0);
        watchGrant(authorized.grant);
        const response = await exchange(
          request,
          route,
          authorized.grant,
          client,
          ends,
        );
        const relayed = new Response(tracked(response.body, release), {
          status: response.status,
          headers: response.headers,
        });
        answered = true;
        if (ends.aborted) release();
        return relayed;
      } catch (error) {
        release();
        logger.error("Credential exchange failed", {
          error: error instanceof Error ? error.name : "error",
        });
        return reply(502, "credential exchange failed", route.purpose);
      }
    },
  });

  logger.info("Credential routes listening", {
    port: server.port,
    authorizer: authorizeUrl.origin,
  });
  return {
    port: server.port ?? 0,
    stop(): void {
      server.stop(true);
    },
  };
}

class BodyTooLargeError extends Error {}

/**
 * The request body in one piece, given up the moment `signal` fires or it
 * passes `max`.
 */
async function readWhole(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  max: number,
): Promise<Uint8Array | null> {
  if (body === null) return null;
  const reader = body.getReader();
  const stop = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
      if (total > max) throw new BodyTooLargeError();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * An object store PUT's body, streamed upstream at the length the authorizer
 * signed. Bun already holds the worker to the length it declared, and the
 * authorizer signed that same declaration; the upstream client checks the
 * stream against it again as it writes.
 */
function objectBody(request: Request, grant: EgressGrant): UpstreamBody {
  const declared = grant.headers.find(([name]) => name === "content-length");
  if (declared === undefined || request.body === null) return null;
  return { stream: request.body, length: Number(declared[1]) };
}

const S3_ERROR_CODES: Record<number, string> = {
  401: "InvalidAccessKeyId",
  403: "AccessDenied",
  409: "AccessDenied",
  413: "EntityTooLarge",
  502: "BadGateway",
  503: "ServiceUnavailable",
};

/**
 * A refusal an S3 client can read: its SDK reports the code as the error's
 * name (`AccessDenied`), and retries the ones S3 itself would have it retry.
 */
function s3Error(status: number, message: string): Response {
  const code = S3_ERROR_CODES[status] ?? "InternalError";
  const escaped = message.replace(
    /[<>&]/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] ?? char,
  );
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${escaped}</Message></Error>\n`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

/** A body that frees its slot once it ends, errors or is cancelled. */
function tracked(
  body: ReadableStream<Uint8Array> | null,
  done: () => void,
): ReadableStream<Uint8Array> | null {
  if (body === null) {
    done();
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          done();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
}

async function readAtMost(
  response: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
