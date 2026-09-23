import { describe, expect, test } from "bun:test";
import { createResponseHeadRewriter } from "./response.ts";

const MAX = 1024;

function rewrite(...chunks: Array<string | Uint8Array>): string {
  const rewriter = createResponseHeadRewriter(MAX);
  let out = "";
  for (const chunk of chunks) {
    const result = rewriter.push(
      typeof chunk === "string" ? latin1(chunk) : chunk,
    );
    if ("error" in result) return `error: ${result.error}`;
    out += String.fromCharCode(...result.bytes);
  }
  return out;
}

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

describe("response head rewriter", () => {
  test("the final head says close and loses every hop-by-hop field", () => {
    expect(
      rewrite(
        "HTTP/1.1 200 OK\r\nConnection: keep-alive, X-Hop\r\nKeep-Alive: timeout=5\r\n" +
          "Proxy-Connection: keep-alive\r\nx-hop: 1\r\nContent-Length: 2\r\n\r\nok",
      ),
    ).toBe(
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nconnection: close\r\n\r\nok",
    );
  });

  test("the answer is the same however the upstream cut it", () => {
    const whole =
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n";
    const expected = rewrite(whole);
    for (let cut = 1; cut < whole.length; cut += 1) {
      expect(rewrite(whole.slice(0, cut), whole.slice(cut))).toBe(expected);
    }
    expect(expected).toBe(
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n",
    );
  });

  test("an interim head keeps its fields but not its hop-by-hop ones", () => {
    expect(
      rewrite(
        "HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\nConnection: keep-alive\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
      ),
    ).toBe(
      "HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\n" +
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nconnection: close\r\n\r\n",
    );
  });

  test("field values keep bytes no text decoding would round-trip", () => {
    const obs = new Uint8Array([0x80, 0x9f, 0xff]);
    const head = latin1("HTTP/1.1 200 OK\r\nX-Raw: ");
    const tail = latin1("\r\n\r\n");
    const out = rewrite(new Uint8Array([...head, ...obs, ...tail]));
    expect(out).toContain(
      `X-Raw: ${String.fromCharCode(0x80, 0x9f, 0xff)}\r\n`,
    );
  });

  test("the body after the head passes as it is", () => {
    const rewriter = createResponseHeadRewriter(MAX);
    rewriter.push(latin1("HTTP/1.1 200 OK\r\n\r\n"));
    expect(rewriter.done).toBe(true);
    const body = latin1("HTTP/1.1 500 not a head\r\n\r\n");
    expect(rewriter.push(body)).toEqual({ bytes: body });
  });

  test.each([
    ["garbage\r\n\r\n", "malformed response status line"],
    ["HTTP/1.1 101 Switching Protocols\r\n\r\n", "unexpected 101 response"],
    [
      "HTTP/1.1 200 OK\r\nConnection: content-length\r\nContent-Length: 2\r\n\r\n",
      "response Connection names content-length",
    ],
    [`HTTP/1.1 200 OK\r\nx: ${"a".repeat(MAX)}`, "response head is larger"],
    [
      "HTTP/1.1 100 Continue\r\n\r\n".repeat(MAX / 16),
      "response head is larger",
    ],
  ])("%# is refused", (answer, error) => {
    expect(rewrite(answer)).toStartWith(`error: ${error}`);
  });
});
