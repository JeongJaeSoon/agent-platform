/**
 * Parsing of the client's HTTP head: its request line plus headers.
 * Everything after it is bytes to be piped, so the parser is strict here;
 * the only other head the proxy reads is the answer's (response.ts).
 */

import { normalizeHost } from "./policy.ts";

export type ProxyRequest =
  | { host: string; kind: "connect"; port: number }
  | {
      body: RequestBody;
      head: string;
      host: string;
      kind: "forward";
      port: number;
    }
  | { kind: "health" }
  | { kind: "invalid"; reason: string; status: number };

/** Headers that describe this hop only and must not be forwarded. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "upgrade",
]);

export const HEALTH_PATH = "/healthz";

export function parseRequestHead(head: string): ProxyRequest {
  const lines = head.split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length !== 3) {
    return invalid(400, "malformed request line");
  }
  const [method = "", target = "", version = ""] = parts;
  if (!version.startsWith("HTTP/1.")) {
    return invalid(505, `unsupported version ${version}`);
  }
  const headers = parseHeaders(lines.slice(1));
  if (headers === null) return invalid(400, "malformed header field");
  if (method === "CONNECT") {
    const authority = splitAuthority(target);
    return authority === null
      ? invalid(400, "CONNECT target must be host:port")
      : { kind: "connect", ...authority };
  }
  if (target.startsWith("/")) {
    return method === "GET" && target === HEALTH_PATH
      ? { kind: "health" }
      : invalid(400, "only absolute-form requests are proxied");
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return invalid(400, "request target is not a URL");
  }
  if (url.protocol !== "http:") {
    // https is tunnelled with CONNECT; the proxy never terminates TLS.
    return invalid(400, `unsupported scheme ${url.protocol}`);
  }
  const body = bodyOf(headers);
  if (typeof body === "string") return invalid(body === TE ? 501 : 400, body);
  const port = url.port === "" ? 80 : Number(url.port);
  return {
    body,
    head: rewrite(method, url, headers),
    host: normalizeHost(url.hostname),
    kind: "forward",
    port,
  };
}

/**
 * Where the one request's body ends, which is where everything the proxy
 * forwards ends (`createBodyFramer`). Two framings, two lengths, or a length
 * that is not plain digits mean two readings of that point, and are refused.
 */
export type RequestBody =
  | { kind: "chunked" }
  | { bytes: number; kind: "length" };

const TE = "only chunked transfer-encoding is proxied";

function bodyOf(headers: Array<[string, string]>): RequestBody | string {
  const lengths = headers.filter(([name]) => name === "content-length");
  const codings = headers.filter(([name]) => name === "transfer-encoding");
  if (lengths.length > 1) return "duplicate content-length";
  if (codings.length > 0 && lengths.length > 0) {
    return "both transfer-encoding and content-length";
  }
  if (codings.length > 0) {
    return codings.length === 1 && codings[0]?.[1].toLowerCase() === "chunked"
      ? { kind: "chunked" }
      : TE;
  }
  const length = lengths[0]?.[1];
  if (length === undefined) return { bytes: 0, kind: "length" };
  const bytes = Number(length);
  return /^\d+$/.test(length) && Number.isSafeInteger(bytes)
    ? { bytes, kind: "length" }
    : "malformed content-length";
}

function invalid(status: number, reason: string): ProxyRequest {
  return { kind: "invalid", reason, status };
}

/** null on an obs-folded or otherwise malformed field, which we never accept. */
function parseHeaders(lines: string[]): Array<[string, string]> | null {
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(" ") || line.startsWith("\t")) return null;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    headers.push([
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    ]);
  }
  return headers;
}

function rewrite(
  method: string,
  url: URL,
  headers: Array<[string, string]>,
): string {
  const path = `${url.pathname}${url.search}` || "/";
  const lines = [`${method} ${path} HTTP/1.1`, `host: ${url.host}`];
  for (const [name, value] of headers) {
    if (name === "host" || HOP_BY_HOP.has(name)) continue;
    lines.push(`${name}: ${value}`);
  }
  // Every forwarded exchange is one request on a fresh upstream connection,
  // which is what lets the proxy pipe the response without framing it.
  lines.push("connection: close", "", "");
  return lines.join("\r\n");
}

/** `host:port` or `[::1]:port`; null when either half is missing. */
export function splitAuthority(
  target: string,
): { host: string; port: number } | null {
  const separator = target.startsWith("[")
    ? target.indexOf("]:") + 1
    : target.lastIndexOf(":");
  if (separator <= 0) return null;
  const host = normalizeHost(target.slice(0, separator));
  const port = Number(target.slice(separator + 1));
  if (host.length === 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A `name: value` line, name lower-cased; undefined for anything else. */
export function parseField(
  line: string,
): { name: string; value: string } | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const name = line.slice(0, colon);
  if (!TOKEN.test(name)) return undefined;
  return { name: name.toLowerCase(), value: line.slice(colon + 1).trim() };
}

/** Index just past the CRLFCRLF that ends the head, or -1. */
export function headEnd(buffer: Uint8Array): number {
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

export type BodyFramer = {
  /**
   * The part of `chunk` that still belongs to the request, and how many
   * bytes past its end were dropped; an error means the body is malformed.
   */
  take(
    chunk: Uint8Array,
  ): { forward: Uint8Array; dropped: number } | { error: string };
};

/** A chunk-size line or a trailer field longer than this is refused. */
const MAX_CHUNK_LINE_BYTES = 4 * 1024;
/** Every trailer field together. */
const MAX_TRAILER_BYTES = 16 * 1024;

/**
 * Counts the one request's body as it is piped, so that nothing a client
 * sends past it — a pipelined request, or one written on a connection it was
 * told to close — reaches the upstream judged for this one (94S-299). Such a
 * request could carry another destination's credentials. The bytes are
 * dropped rather than answered: the client has its `connection: close`
 * (response.ts) and closes once it has read the answer.
 *
 * Chunked bodies are framed rather than refused: git over http sends one
 * whenever a request outgrows its `http.postBuffer`.
 */
export function createBodyFramer(body: RequestBody): BodyFramer {
  if (body.kind === "length") {
    let left = body.bytes;
    return {
      take(chunk) {
        const take = Math.min(left, chunk.byteLength);
        left -= take;
        return {
          dropped: chunk.byteLength - take,
          forward: chunk.subarray(0, take),
        };
      },
    };
  }
  let state: "size" | "data" | "data-end" | "trailer" | "done" = "size";
  /** Data bytes left in the current chunk, or CRLF bytes left after it. */
  let left = 0;
  let line: number[] = [];
  let trailerBytes = 0;
  return {
    take(chunk) {
      let at = 0;
      while (at < chunk.byteLength && state !== "done") {
        if (state === "data") {
          const take = Math.min(left, chunk.byteLength - at);
          at += take;
          left -= take;
          if (left === 0) {
            state = "data-end";
            left = 2;
          }
          continue;
        }
        const byte = chunk[at] ?? 0;
        at += 1;
        if (state === "data-end") {
          if (byte !== (left === 2 ? 13 : 10)) {
            return { error: "chunk data not followed by CRLF" };
          }
          left -= 1;
          if (left === 0) state = "size";
          continue;
        }
        line.push(byte);
        if (line.length > MAX_CHUNK_LINE_BYTES) {
          return { error: "chunk line is too long" };
        }
        if (state === "trailer" && ++trailerBytes > MAX_TRAILER_BYTES) {
          return { error: "chunked trailer is too large" };
        }
        const length = line.length;
        if (length < 2 || line[length - 2] !== 13 || line[length - 1] !== 10) {
          continue;
        }
        const text = String.fromCharCode(...line.slice(0, -2));
        line = [];
        if (state === "trailer") {
          if (text === "") state = "done";
          // A trailer that is not a field could be the next request riding
          // in the body's tail.
          else if (parseField(text) === undefined) {
            return { error: "malformed chunked trailer field" };
          }
          continue;
        }
        const size = /^([0-9a-fA-F]{1,12})(?:[ \t]*;.*)?$/.exec(text)?.[1];
        if (size === undefined) return { error: "malformed chunk size" };
        left = Number.parseInt(size, 16);
        state = left === 0 ? "trailer" : "data";
      }
      return {
        dropped: chunk.byteLength - at,
        forward: chunk.subarray(0, at),
      };
    },
  };
}
