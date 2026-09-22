/**
 * Parsing of the one HTTP head the proxy ever reads: the client's request
 * line plus headers. Everything after it is bytes to be piped, so the parser
 * is strict here and nowhere else.
 */

import { normalizeHost } from "./policy.ts";

export type ProxyRequest =
  | { host: string; kind: "connect"; port: number }
  | { head: string; host: string; kind: "forward"; port: number }
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
  // Two framings, or two lengths, mean two readings of where the body ends.
  if (headers.filter(([name]) => name === "content-length").length > 1) {
    return invalid(400, "duplicate content-length");
  }
  if (
    headers.some(([name]) => name === "transfer-encoding") &&
    headers.some(([name]) => name === "content-length")
  ) {
    return invalid(400, "both transfer-encoding and content-length");
  }
  const port = url.port === "" ? 80 : Number(url.port);
  return {
    head: rewrite(method, url, headers),
    host: normalizeHost(url.hostname),
    kind: "forward",
    port,
  };
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
