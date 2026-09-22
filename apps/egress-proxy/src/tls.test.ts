import { describe, expect, test } from "bun:test";
import {
  clientHello,
  EXTENSION_ENCRYPTED_CLIENT_HELLO,
} from "./testing/client-hello.ts";
import { MAX_CLIENT_HELLO_BYTES, parseClientHelloSni } from "./tls.ts";

describe("parseClientHelloSni", () => {
  test("reads the one host_name a normal ClientHello carries", () => {
    expect(
      parseClientHelloSni(clientHello({ serverNames: ["api.anthropic.com"] })),
    ).toEqual({ host: "api.anthropic.com", kind: "sni" });
  });

  test("a hello without server_name is complete but nameless", () => {
    expect(parseClientHelloSni(clientHello())).toEqual({ kind: "no-sni" });
  });

  test("bytes past the ClientHello are not read", () => {
    const hello = clientHello({ serverNames: ["a.test"] });
    const trailing = new Uint8Array(hello.byteLength + 3);
    trailing.set(hello);
    trailing.set([0xff, 0xff, 0xff], hello.byteLength);
    expect(parseClientHelloSni(trailing)).toEqual({
      host: "a.test",
      kind: "sni",
    });
  });

  test("is incomplete until the last record arrives", () => {
    const hello = clientHello({ serverNames: ["a.test"] });
    for (const cut of [0, 3, 5, 20, hello.byteLength - 1]) {
      expect(parseClientHelloSni(hello.subarray(0, cut))).toEqual({
        kind: "incomplete",
      });
    }
    expect(parseClientHelloSni(hello)).toEqual({ host: "a.test", kind: "sni" });
  });

  test("reassembles a ClientHello split across handshake records", () => {
    const split = clientHello({ recordSize: 7, serverNames: ["split.test"] });
    expect(parseClientHelloSni(split)).toEqual({
      host: "split.test",
      kind: "sni",
    });
    expect(
      parseClientHelloSni(split.subarray(0, split.byteLength - 4)),
    ).toEqual({ kind: "incomplete" });
  });

  test("a first record that is not a handshake is rejected", () => {
    const verdict = parseClientHelloSni(
      clientHello({ contentType: 23, serverNames: ["a.test"] }),
    );
    expect(verdict).toMatchObject({ kind: "reject" });
    expect(verdict).toMatchObject({ reason: expect.stringContaining("23") });

    expect(
      parseClientHelloSni(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")),
    ).toMatchObject({ kind: "reject" });
  });

  test("a record that is not TLS is rejected", () => {
    const bytes = clientHello({ serverNames: ["a.test"] });
    bytes[1] = 2;
    expect(parseClientHelloSni(bytes)).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("not TLS"),
    });
  });

  test("a handshake message other than ClientHello is rejected", () => {
    expect(
      parseClientHelloSni(
        clientHello({ handshakeType: 2, serverNames: ["a"] }),
      ),
    ).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("not a ClientHello"),
    });
  });

  test("encrypted_client_hello is rejected outright", () => {
    expect(
      parseClientHelloSni(
        clientHello({
          extensions: [
            {
              data: Uint8Array.from([0, 1, 2]),
              type: EXTENSION_ENCRYPTED_CLIENT_HELLO,
            },
          ],
          serverNames: ["public.test"],
        }),
      ),
    ).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("encrypted_client_hello"),
    });
  });

  test("a ClientHello that says it is larger than the cap is rejected early", () => {
    const bytes = clientHello({ serverNames: ["a.test"] });
    // Handshake length field is at offset 6..8 (after the record header).
    bytes[6] = 0x00;
    bytes[7] = 0x40;
    bytes[8] = 0x01;
    expect(parseClientHelloSni(bytes)).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining(`${MAX_CLIENT_HELLO_BYTES}`),
    });
  });

  test("an oversized or empty record is rejected", () => {
    const empty = Uint8Array.from([22, 3, 1, 0, 0]);
    expect(parseClientHelloSni(empty)).toMatchObject({ kind: "reject" });
    const huge = Uint8Array.from([22, 3, 1, 0x40, 0x01]);
    expect(parseClientHelloSni(huge)).toMatchObject({ kind: "reject" });
  });

  test("two host_name entries are rejected rather than picked between", () => {
    expect(
      parseClientHelloSni(clientHello({ serverNames: ["a.test", "b.test"] })),
    ).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("more than one"),
    });
  });

  test("a duplicated server_name extension is rejected", () => {
    const first = clientHello({ serverNames: ["a.test"] });
    // Splice the same server_name extension in twice by building the second
    // as a raw extension.
    const sni = clientHello({ serverNames: ["b.test"] });
    // Find the server_name extension body in `sni`: it is the only extension.
    const extensionsStart = sni.byteLength - (4 + 2 + 3 + "b.test".length);
    const data = sni.subarray(extensionsStart + 4);
    expect(
      parseClientHelloSni(
        clientHello({
          extensions: [{ data, type: 0 }],
          serverNames: ["a.test"],
        }),
      ),
    ).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("duplicate"),
    });
    expect(parseClientHelloSni(first)).toMatchObject({ kind: "sni" });
  });

  test("a host_name that is empty, non-ASCII or dotted is rejected", () => {
    expect(
      parseClientHelloSni(clientHello({ serverNames: [""] })),
    ).toMatchObject({ kind: "reject" });
    expect(
      parseClientHelloSni(clientHello({ serverNames: ["ünïcode.test"] })),
    ).toMatchObject({ kind: "reject" });
    expect(
      parseClientHelloSni(clientHello({ serverNames: ["a.test."] })),
    ).toMatchObject({ kind: "reject" });
  });

  test("an extensions length that disagrees with the message is rejected", () => {
    const bytes = clientHello({ serverNames: ["a.test"] });
    // Extensions length sits right after compression methods: 5 (record) +
    // 4 (handshake) + 2 + 32 + 1 + 2 + 2 + 1 + 1 = 50.
    bytes[50] = 0x00;
    bytes[51] = 0x01;
    expect(parseClientHelloSni(bytes)).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("extensions length"),
    });
  });
});
