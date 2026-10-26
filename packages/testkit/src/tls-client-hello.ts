/**
 * Builds the smallest ClientHello a test needs: one cipher suite, null
 * compression, and whatever extensions the case calls for. Used by the
 * proxy's own tests and by the Docker egress suite, which feeds the bytes
 * through `printf | nc` from inside the worker network.
 */

export type ClientHelloOptions = {
  /** Extra raw extensions, appended after server_name. */
  extensions?: Array<{ data: Uint8Array; type: number }>;
  /** The host_name entries to put in server_name; none omits the extension. */
  serverNames?: string[];
  /** Split the handshake message across records of at most this many bytes. */
  recordSize?: number;
  /** Override the byte that says which handshake message this is. */
  handshakeType?: number;
  /** Override the record's content type. */
  contentType?: number;
};

export const EXTENSION_ENCRYPTED_CLIENT_HELLO = 0xfe0d;

export function clientHello(options: ClientHelloOptions = {}): Uint8Array {
  const body: number[] = [];
  body.push(0x03, 0x03);
  for (let i = 0; i < 32; i += 1) body.push(i);
  body.push(0);
  body.push(0x00, 0x02, 0x13, 0x01);
  body.push(0x01, 0x00);
  const extensions: number[] = [];
  const names = options.serverNames;
  if (names !== undefined) {
    const list: number[] = [];
    for (const name of names) {
      const encoded = Array.from(new TextEncoder().encode(name));
      list.push(0, ...uint16(encoded.length), ...encoded);
    }
    extensions.push(...extension(0, [...uint16(list.length), ...list]));
  }
  for (const extra of options.extensions ?? []) {
    extensions.push(...extension(extra.type, Array.from(extra.data)));
  }
  if (extensions.length > 0) {
    body.push(...uint16(extensions.length), ...extensions);
  }
  const message = [options.handshakeType ?? 1, ...uint24(body.length), ...body];
  const recordSize = options.recordSize ?? message.length;
  const out: number[] = [];
  for (let at = 0; at < message.length; at += recordSize) {
    const fragment = message.slice(at, at + recordSize);
    out.push(
      options.contentType ?? 22,
      0x03,
      0x01,
      ...uint16(fragment.length),
      ...fragment,
    );
  }
  return Uint8Array.from(out);
}

/** The bytes as a `printf` argument, for a shell that has no TLS client. */
export function asPrintfEscapes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

function extension(type: number, data: number[]): number[] {
  return [...uint16(type), ...uint16(data.length), ...data];
}

function uint16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function uint24(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
