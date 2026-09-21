import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeAnthropicServer,
  overloadedError,
  quotaError,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "./fake-anthropic.ts";

let server: FakeAnthropicServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

async function postMessages(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${url}/v1/messages?beta=true`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

describe("fake Anthropic Messages API", () => {
  test("records requests and answers a non-streaming call as JSON", async () => {
    server = startFakeAnthropicServer(textReply("hello"));
    const response = await postMessages(
      server.url,
      { model: "claude-sonnet-4-5", messages: [] },
      { "x-api-key": "placeholder-local" },
    );
    const message = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("request-id")).toStartWith("req_");
    expect(message.model).toBe("claude-sonnet-4-5");
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe("/v1/messages?beta=true");
    expect(server.requests[0]?.headers["x-api-key"]).toBe("placeholder-local");
    expect(server.requests[0]?.body.model).toBe("claude-sonnet-4-5");
  });

  test("streams every block as SSE when the request asks for a stream", async () => {
    server = startFakeAnthropicServer(
      toolReply("Bash", { command: "ls" }, "toolu_1"),
    );
    const response = await postMessages(server.url, {
      model: "claude-sonnet-4-5",
      stream: true,
      messages: [],
    });
    const text = await response.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"partial_json":"{\\"command\\":\\"ls\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  test("plays an array script in order and repeats the last entry", async () => {
    server = startFakeAnthropicServer([textReply("one"), textReply("two")]);
    const texts: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await postMessages(server.url, { messages: [] });
      const message = (await response.json()) as {
        content: Array<{ text: string }>;
      };
      texts.push(message.content[0]?.text ?? "");
    }
    expect(texts).toEqual(["one", "two", "two"]);
  });

  test("serves a scripted Response object more than once", async () => {
    server = startFakeAnthropicServer([
      Response.json({ custom: true }, { status: 418 }),
    ]);
    const first = await postMessages(server.url, { messages: [] });
    const second = await postMessages(server.url, { messages: [] });
    expect([first.status, second.status]).toEqual([418, 418]);
    expect(await first.json()).toEqual({ custom: true });
    expect(await second.json()).toEqual({ custom: true });
  });

  test("passes the recorded request and index to a resolver", async () => {
    server = startFakeAnthropicServer((request, index) =>
      textReply(`${request.body.model}-${index}`),
    );
    await postMessages(server.url, { model: "a", messages: [] });
    const second = await postMessages(server.url, { model: "b", messages: [] });
    const message = (await second.json()) as {
      content: Array<{ text: string }>;
    };
    expect(message.content[0]?.text).toBe("b-1");
  });

  test("injects latency and Anthropic-shaped failures", async () => {
    server = startFakeAnthropicServer(textReply("never"), {
      failWith: (_request, index) =>
        index === 0
          ? quotaError()
          : index === 1
            ? overloadedError()
            : undefined,
      latencyMs: 50,
    });
    const started = Date.now();
    const quota = await postMessages(server.url, { messages: [] });
    const overloaded = await postMessages(server.url, { messages: [] });
    const ok = await postMessages(server.url, { messages: [] });

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(quota.status).toBe(429);
    expect(await quota.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    });
    expect(overloaded.status).toBe(529);
    expect(ok.status).toBe(200);
    expect(server.requests).toHaveLength(3);
  });

  test("returns 404 for anything but POST /messages", async () => {
    server = startFakeAnthropicServer(textReply("x"));
    const response = await fetch(`${server.url}/v1/models`);
    expect(response.status).toBe(404);
    expect(server.requests).toHaveLength(0);
  });
});
