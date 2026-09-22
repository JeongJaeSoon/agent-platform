import { describe, expect, test } from "bun:test";
import { parseRequestHead } from "./request.ts";

function head(...lines: string[]): string {
  return lines.join("\r\n");
}

describe("parseRequestHead", () => {
  test("CONNECT carries the authority", () => {
    expect(
      parseRequestHead(
        head("CONNECT api.example.com:443 HTTP/1.1", "host: api.example.com"),
      ),
    ).toEqual({ host: "api.example.com", kind: "connect", port: 443 });
  });

  test("a CONNECT without a port is refused", () => {
    expect(
      parseRequestHead(head("CONNECT api.example.com HTTP/1.1")),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("absolute-form is rewritten to origin-form with a fresh Host", () => {
    const parsed = parseRequestHead(
      head(
        "POST http://gateway.test:3000/v1/claim?x=1 HTTP/1.1",
        "Host: proxy-was-told-something-else",
        "Content-Length: 4",
        "Proxy-Connection: keep-alive",
        "Connection: keep-alive",
        "User-Agent: worker",
      ),
    );
    expect(parsed).toMatchObject({
      host: "gateway.test",
      kind: "forward",
      port: 3000,
    });
    if (parsed.kind !== "forward") throw new Error("expected a forward");
    expect(parsed.head).toBe(
      head(
        "POST /v1/claim?x=1 HTTP/1.1",
        "host: gateway.test:3000",
        "content-length: 4",
        "user-agent: worker",
        "connection: close",
        "",
        "",
      ),
    );
  });

  test("an absolute URL with no port defaults to 80", () => {
    expect(parseRequestHead(head("GET http://a.test/ HTTP/1.1"))).toMatchObject(
      { host: "a.test", port: 80 },
    );
  });

  test("https absolute-form is refused; that is what CONNECT is for", () => {
    expect(
      parseRequestHead(head("GET https://a.test/ HTTP/1.1")),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("only /healthz is answered in origin-form", () => {
    expect(parseRequestHead(head("GET /healthz HTTP/1.1"))).toEqual({
      kind: "health",
    });
    expect(parseRequestHead(head("GET /other HTTP/1.1"))).toMatchObject({
      kind: "invalid",
      status: 400,
    });
  });

  test("conflicting or duplicated body framing is refused", () => {
    expect(
      parseRequestHead(
        head(
          "POST http://a.test/ HTTP/1.1",
          "Content-Length: 4",
          "Content-Length: 5",
        ),
      ),
    ).toMatchObject({ kind: "invalid", status: 400 });
    expect(
      parseRequestHead(
        head(
          "POST http://a.test/ HTTP/1.1",
          "Content-Length: 4",
          "Transfer-Encoding: chunked",
        ),
      ),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("an obs-folded header is refused rather than re-joined", () => {
    expect(
      parseRequestHead(
        head("GET http://a.test/ HTTP/1.1", "X-Thing: one", "  two"),
      ),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("a non-HTTP/1 request line is refused", () => {
    expect(parseRequestHead(head("GET http://a.test/ HTTP/2"))).toMatchObject({
      kind: "invalid",
      status: 505,
    });
    expect(parseRequestHead(head("nonsense"))).toMatchObject({
      kind: "invalid",
      status: 400,
    });
  });
});
