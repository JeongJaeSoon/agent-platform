/**
 * Just enough TLS to read the server name a CONNECT client is really
 * asking for. The proxy judged the CONNECT authority against the allowlist
 * and resolved it; a ClientHello naming anything else is a tunnel to a
 * destination that was never judged, which on a shared CDN edge is a way
 * around the whole allowlist.
 *
 * The parser is deliberately narrow and fail-closed: anything that is not a
 * ClientHello it can read to the end is a rejection, never a shrug. It
 * reads bytes and returns a verdict; policy — which name is acceptable —
 * stays in the proxy.
 */

/**
 * More than this and the ClientHello is not one this proxy will wait for.
 * Real hellos are a few hundred bytes to a couple of kilobytes even with a
 * post-quantum key share; the cap exists so an unfinished one cannot hold a
 * buffer open.
 */
export const MAX_CLIENT_HELLO_BYTES = 16 * 1024;

/** RFC 8446 §5.1: a record's plaintext fragment is at most 2^14 bytes. */
const MAX_RECORD_FRAGMENT = 16_384;
const RECORD_HEADER = 5;
const HANDSHAKE_HEADER = 4;
const CONTENT_TYPE_HANDSHAKE = 22;
const HANDSHAKE_CLIENT_HELLO = 1;
const EXTENSION_SERVER_NAME = 0;
/** draft-ietf-tls-esni: the outer SNI is then a decoy, not the destination. */
const EXTENSION_ENCRYPTED_CLIENT_HELLO = 0xfe0d;
const NAME_TYPE_HOST_NAME = 0;

export type ClientHelloVerdict =
  /** A complete ClientHello whose server_name extension names one host. */
  | { host: string; kind: "sni" }
  /** A complete ClientHello that carries no server_name extension. */
  | { kind: "no-sni" }
  /** Not enough bytes yet; call again with more. */
  | { kind: "incomplete" }
  | { kind: "reject"; reason: string };

/**
 * Reads the ClientHello at the start of `bytes`, which may span several
 * handshake records. Bytes past the end of the hello are not looked at.
 */
export function parseClientHelloSni(bytes: Uint8Array): ClientHelloVerdict {
  const collected = collectHandshake(bytes);
  if (collected.kind !== "handshake") return collected;
  return parseClientHello(collected.message);
}

type Collected =
  | { kind: "handshake"; message: Uint8Array }
  | { kind: "incomplete" }
  | { kind: "reject"; reason: string };

/**
 * Walks handshake records until one whole handshake message is in hand. A
 * ClientHello may be split across records (RFC 8446 §5.1 allows it, and
 * some stacks do it to dodge middleboxes), so the fragments are joined
 * before the message is read.
 */
function collectHandshake(bytes: Uint8Array): Collected {
  const fragments: Uint8Array[] = [];
  let gathered = 0;
  let offset = 0;
  let wanted: number | null = null;
  for (;;) {
    if (wanted !== null && gathered >= wanted) break;
    if (bytes.byteLength - offset < RECORD_HEADER)
      return { kind: "incomplete" };
    const type = bytes[offset];
    const versionMajor = bytes[offset + 1];
    const length = readUint16(bytes, offset + 3);
    if (type !== CONTENT_TYPE_HANDSHAKE) {
      return {
        kind: "reject",
        reason: `first record is not a TLS handshake (content type ${type})`,
      };
    }
    if (versionMajor !== 3) {
      return {
        kind: "reject",
        reason: `record version ${versionMajor}.${bytes[offset + 2]} is not TLS`,
      };
    }
    if (length === 0 || length > MAX_RECORD_FRAGMENT) {
      return { kind: "reject", reason: `record length ${length} is invalid` };
    }
    const start = offset + RECORD_HEADER;
    const end = start + length;
    if (bytes.byteLength < end) return { kind: "incomplete" };
    fragments.push(bytes.subarray(start, end));
    gathered += length;
    offset = end;
    if (wanted === null && gathered >= HANDSHAKE_HEADER) {
      const head = join(fragments, HANDSHAKE_HEADER);
      if (head[0] !== HANDSHAKE_CLIENT_HELLO) {
        return {
          kind: "reject",
          reason: `first handshake message is not a ClientHello (type ${head[0]})`,
        };
      }
      const bodyLength = readUint24(head, 1);
      wanted = HANDSHAKE_HEADER + bodyLength;
      if (wanted > MAX_CLIENT_HELLO_BYTES) {
        return {
          kind: "reject",
          reason: `ClientHello of ${wanted} bytes exceeds the ${MAX_CLIENT_HELLO_BYTES} byte cap`,
        };
      }
    }
  }
  if (wanted === null) return { kind: "incomplete" };
  return { kind: "handshake", message: join(fragments, wanted) };
}

/**
 * The ClientHello body, RFC 8446 §4.1.2. Everything before the extensions
 * is skipped by length; the extensions are walked in full so a malformed
 * list cannot hide a server_name from us that the server will still see.
 */
function parseClientHello(message: Uint8Array): ClientHelloVerdict {
  const body = message.subarray(HANDSHAKE_HEADER);
  let offset = 0;
  const need = (count: number, what: string): boolean => {
    if (body.byteLength - offset >= count) return true;
    // Reachable only through a corrupt length: the record layer already
    // handed over the whole message.
    reason = `ClientHello is truncated at its ${what}`;
    return false;
  };
  let reason = "";
  if (!need(2 + 32, "version and random")) return reject(reason);
  offset += 2 + 32;
  if (!need(1, "session id length")) return reject(reason);
  const sessionIdLength = body[offset] ?? 0;
  offset += 1;
  if (sessionIdLength > 32) return reject("session id is longer than 32 bytes");
  if (!need(sessionIdLength, "session id")) return reject(reason);
  offset += sessionIdLength;
  if (!need(2, "cipher suites length")) return reject(reason);
  const cipherSuitesLength = readUint16(body, offset);
  offset += 2;
  if (cipherSuitesLength < 2 || cipherSuitesLength % 2 !== 0) {
    return reject(`cipher suites length ${cipherSuitesLength} is invalid`);
  }
  if (!need(cipherSuitesLength, "cipher suites")) return reject(reason);
  offset += cipherSuitesLength;
  if (!need(1, "compression methods length")) return reject(reason);
  const compressionLength = body[offset] ?? 0;
  offset += 1;
  if (compressionLength < 1) return reject("no compression method");
  if (!need(compressionLength, "compression methods")) return reject(reason);
  offset += compressionLength;
  // Pre-extension hellos (SSL 3.0 / TLS 1.0 era) end here and are legal:
  // the verdict is simply that no name was sent.
  if (offset === body.byteLength) return { kind: "no-sni" };
  if (!need(2, "extensions length")) return reject(reason);
  const extensionsLength = readUint16(body, offset);
  offset += 2;
  if (body.byteLength - offset !== extensionsLength) {
    return reject("extensions length does not match the ClientHello");
  }
  const seen = new Set<number>();
  let host: string | null = null;
  while (offset < body.byteLength) {
    if (!need(4, "extension header")) return reject(reason);
    const type = readUint16(body, offset);
    const length = readUint16(body, offset + 2);
    offset += 4;
    if (!need(length, `extension ${type}`)) return reject(reason);
    const data = body.subarray(offset, offset + length);
    offset += length;
    // RFC 8446 §4.2: one of each. Two server_name extensions would leave
    // the server to pick, and we cannot know which it picks.
    if (seen.has(type)) return reject(`duplicate extension ${type}`);
    seen.add(type);
    if (type === EXTENSION_ENCRYPTED_CLIENT_HELLO) {
      return reject("encrypted_client_hello hides the real server name");
    }
    if (type === EXTENSION_SERVER_NAME) {
      const parsed = parseServerNameList(data);
      if (parsed.kind === "reject") return parsed;
      host = parsed.host;
    }
  }
  return host === null ? { kind: "no-sni" } : { host, kind: "sni" };
}

/** RFC 6066 §3: exactly one host_name, ASCII, no trailing dot. */
function parseServerNameList(
  data: Uint8Array,
): { host: string; kind: "sni" } | { kind: "reject"; reason: string } {
  if (data.byteLength < 2) return reject("server_name extension is empty");
  const listLength = readUint16(data, 0);
  if (listLength !== data.byteLength - 2) {
    return reject("server_name list length does not match the extension");
  }
  let offset = 2;
  let host: string | null = null;
  while (offset < data.byteLength) {
    if (data.byteLength - offset < 3) {
      return reject("server_name entry is truncated");
    }
    const nameType = data[offset];
    const nameLength = readUint16(data, offset + 1);
    offset += 3;
    if (data.byteLength - offset < nameLength) {
      return reject("server_name entry is truncated");
    }
    const name = data.subarray(offset, offset + nameLength);
    offset += nameLength;
    // The RFC defines only host_name and forbids repeating a type. Anything
    // else is a name we cannot judge, so it is not a name we pass.
    if (nameType !== NAME_TYPE_HOST_NAME) {
      return reject(`server_name type ${nameType} is not host_name`);
    }
    if (host !== null) return reject("more than one host_name in server_name");
    if (nameLength === 0) return reject("host_name is empty");
    for (const byte of name) {
      if (byte <= 0x20 || byte >= 0x7f) {
        return reject("host_name is not printable ASCII");
      }
    }
    host = String.fromCharCode(...name);
  }
  if (host === null) return reject("server_name has no host_name");
  if (host.endsWith(".")) return reject("host_name ends with a dot");
  return { host, kind: "sni" };
}

function reject(reason: string): { kind: "reject"; reason: string } {
  return { kind: "reject", reason };
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 16) |
    ((bytes[offset + 1] ?? 0) << 8) |
    (bytes[offset + 2] ?? 0)
  );
}

/** The first `count` bytes across the fragments, copied once. */
function join(fragments: Uint8Array[], count: number): Uint8Array {
  const out = new Uint8Array(count);
  let filled = 0;
  for (const fragment of fragments) {
    if (filled >= count) break;
    const take = Math.min(fragment.byteLength, count - filled);
    out.set(fragment.subarray(0, take), filled);
    filled += take;
  }
  return out;
}
