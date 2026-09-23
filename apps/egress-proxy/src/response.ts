/**
 * The response heads of a forwarded (absolute-form) exchange, rewritten so
 * the client closes the connection after the one answer it gets.
 *
 * The proxy forwards exactly one request per client connection and pipes the
 * answer without framing it. It asks the upstream to close (`rewrite` in
 * request.ts), but an upstream may not: Bun.serve keeps a connection open
 * after any answer its handler produced asynchronously, and says nothing in
 * the head. A client that reads such a head as keep-alive pools the proxy
 * connection and sends its next request — to whatever origin — down it, and
 * those bytes reach the upstream judged for the first request. That is how a
 * worker's S3 list after its gateway claim landed on the API (94S-299).
 *
 * So the final head the client sees always says `connection: close`,
 * whatever the upstream said; interim 1xx heads only lose their hop-by-hop
 * fields. Only heads are read; the body is still piped, and it ends when
 * either side closes. The request side of the same contract — nothing past
 * the one request reaches the upstream — is `createBodyFramer` in request.ts.
 */

import { headEnd, parseField } from "./request.ts";

/** Hop-by-hop headers of the upstream's hop, none of which reach the client. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
]);

const CRLF = new Uint8Array([13, 10]);
const CLOSE = new TextEncoder().encode("connection: close\r\n\r\n");

export type ResponseHeadRewriter = {
  /** Bytes for the client, possibly none yet; an error ends the exchange. */
  push(chunk: Uint8Array): { bytes: Uint8Array } | { error: string };
  /** The final head has gone through; the rest is body. */
  readonly done: boolean;
  /** Something has been handed to the client (a head, interim or final). */
  readonly started: boolean;
};

/**
 * `maxHeadBytes` bounds every head the answer starts with together, interim
 * ones included, so an upstream cannot keep the client busy with 1xx heads.
 */
export function createResponseHeadRewriter(
  maxHeadBytes: number,
): ResponseHeadRewriter {
  let buffer: Uint8Array = new Uint8Array(0);
  /** Head bytes already handed on: the interim heads before this one. */
  let consumed = 0;
  let done = false;
  let started = false;
  return {
    get done() {
      return done;
    },
    get started() {
      return started;
    },
    push(chunk) {
      if (done) return { bytes: chunk };
      // Only what is returned reaches the client: heads assembled in a push
      // that then fails never do, and must not count as started.
      const handOver = (out: Uint8Array[]) => {
        if (out.length > 0) started = true;
        return { bytes: join(out) };
      };
      buffer = concat(buffer, chunk);
      const out: Uint8Array[] = [];
      for (;;) {
        const end = headEnd(buffer);
        const size = consumed + (end < 0 ? buffer.byteLength : end - 4);
        if (size > maxHeadBytes) {
          return {
            error: `response head is larger than ${maxHeadBytes} bytes`,
          };
        }
        if (end < 0) return handOver(out);
        const lines = splitLines(buffer.subarray(0, end - 4));
        const status = statusOf(lines[0] ?? new Uint8Array(0));
        if (status === null) return { error: "malformed response status line" };
        // The request's Upgrade never reaches the upstream, so a switch is
        // an answer to something nobody asked for.
        if (status === 101) return { error: "unexpected 101 response" };
        const kept = withoutHopFields(lines);
        if (typeof kept === "string") return { error: kept };
        consumed += end;
        buffer = buffer.slice(end);
        if (status < 200) {
          out.push(kept, CRLF);
          continue;
        }
        out.push(kept, CLOSE, buffer);
        buffer = new Uint8Array(0);
        done = true;
        return handOver(out);
      }
    },
  };
}

/**
 * The head's own lines, each with its CRLF, minus every hop-by-hop field and
 * every field the upstream's Connection names. Lines are kept as bytes: a
 * field value may carry obs-text no text decoding round-trips. A Connection
 * that names the framing is refused rather than obeyed: dropping those
 * fields while piping the body as framed would hand the client a body it
 * cannot delimit.
 */
function withoutHopFields(lines: Uint8Array[]): Uint8Array | string {
  const named = new Set<string>();
  for (const line of lines.slice(1)) {
    const field = fieldOf(line);
    if (field?.name !== "connection") continue;
    for (const token of field.value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name === "content-length" || name === "transfer-encoding") {
        return `response Connection names ${name}`;
      }
      if (name !== "") named.add(name);
    }
  }
  const kept: Uint8Array[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      const name = fieldOf(line)?.name;
      if (name === undefined) return "malformed response header field";
      if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    }
    kept.push(line, CRLF);
  }
  return join(kept);
}

function statusOf(line: Uint8Array): number | null {
  const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |$)/.exec(ascii(line));
  return match === null ? null : Number(match[1]);
}

/**
 * Name lower-cased and value trimmed; undefined for anything that is not a
 * header field — no colon, a name that is not a token, or an obs-fold
 * continuation, none of which a client should be left to interpret.
 */
function fieldOf(
  line: Uint8Array,
): { name: string; value: string } | undefined {
  return parseField(ascii(line));
}

function splitLines(head: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 1; i < head.byteLength; i += 1) {
    if (head[i] === 10 && head[i - 1] === 13) {
      lines.push(head.subarray(start, i - 1));
      start = i + 1;
    }
  }
  lines.push(head.subarray(start));
  return lines;
}

/** Byte-for-byte: only ever compared against ASCII names and tokens. */
function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  return join([left, right]);
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
