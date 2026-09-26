import { describe, expect, test } from "bun:test";
import { requestEstimate, usageMeter } from "./usage.ts";

const encoder = new TextEncoder();
const request = encoder.encode(
  JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 500 }),
);

function metered(contentType: string, chunks: string[]) {
  const meter = usageMeter(contentType);
  for (const chunk of chunks) meter.observe(encoder.encode(chunk));
  return meter.result(request);
}

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const noTools = {
  speed: "standard",
  web_search_requests: 0,
  web_fetch_requests: 0,
  code_execution_requests: 0,
};

const started = {
  type: "message_start",
  message: {
    model: "claude-sonnet-4-5",
    content: [],
    usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40 },
  },
};

describe("usageMeter", () => {
  test("reads a JSON answer's model and usage, split anywhere", () => {
    const body = JSON.stringify({
      type: "message",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 6,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 2,
        },
      },
    });
    expect(
      metered("application/json", [body.slice(0, 20), body.slice(20)]),
    ).toEqual({
      model: "claude-sonnet-4-5",
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 6,
      cache_creation_1h_input_tokens: 2,
      ...noTools,
      estimated: false,
    });
  });

  test("takes the input side from message_start and the last message_delta's running totals", () => {
    const stream = sse([
      started,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      { type: "message_delta", delta: {}, usage: { output_tokens: 20 } },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 57, input_tokens: 100 },
      },
      { type: "message_stop" },
    ]);
    // Split mid-line to show lines are rejoined.
    const pieces = [
      stream.slice(0, 7),
      stream.slice(7, 150),
      stream.slice(150),
    ];
    expect(metered("text/event-stream; charset=utf-8", pieces)).toEqual({
      model: "claude-sonnet-4-5",
      input_tokens: 100,
      output_tokens: 57,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 40,
      cache_creation_1h_input_tokens: 0,
      ...noTools,
      estimated: false,
    });
  });

  test("a stream cut before message_stop charges a token per content character it delivered (Codex R1)", () => {
    const text = "x".repeat(300);
    const stream = sse([
      started,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "message_delta", delta: {}, usage: { output_tokens: 20 } },
    ]);
    expect(metered("text/event-stream", [stream])).toMatchObject({
      input_tokens: 100,
      output_tokens: 300,
      estimated: true,
    });
  });

  test("a JSON answer that says nothing usable is charged from its request (Codex R1)", () => {
    const fromRequest = {
      model: "claude-sonnet-4-5",
      input_tokens: request.byteLength,
      output_tokens: 500,
      estimated: true,
    };
    expect(metered("application/json", ['{"id":"msg_1"}'])).toMatchObject(
      fromRequest,
    );
    expect(metered("application/json", ['{"model":"m","usa'])).toMatchObject(
      fromRequest,
    );
    expect(
      metered("application/json", ["x".repeat(9 * 1024 * 1024)]),
    ).toMatchObject(fromRequest);
    expect(
      metered("text/event-stream", [sse([{ type: "ping" }])]),
    ).toMatchObject(fromRequest);
  });

  test("a request that is not JSON is priced as an unknown model", () => {
    expect(requestEstimate(encoder.encode("nope"))).toMatchObject({
      model: "unknown",
      input_tokens: 4,
      output_tokens: 0,
      estimated: true,
    });
  });

  test("a huge content line is skipped without being held, and still counted", () => {
    const big = `data: ${"x".repeat(300 * 1024)}\n\n`;
    const head = sse([started]);
    const tail = sse([{ type: "message_delta", usage: { output_tokens: 3 } }]);
    const result = metered("text/event-stream", [
      head,
      big.slice(0, 1000),
      big.slice(1000),
      tail,
    ]);
    expect(result.estimated).toBe(true);
    expect(result.output_tokens).toBeGreaterThan(300 * 1024);
  });

  describe("speed and server tools (94S-451)", () => {
    const tools = {
      web_search_requests: 2,
      web_fetch_requests: 1,
      code_execution_requests: 3,
    };

    test("a JSON answer's usage.speed and server_tool_use are read", () => {
      const body = JSON.stringify({
        model: "claude-opus-5",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          speed: "fast",
          server_tool_use: tools,
        },
      });
      expect(metered("application/json", [body])).toMatchObject({
        speed: "fast",
        ...tools,
        estimated: false,
      });
    });

    test("a stream's last message_delta counts win, and message_start's speed stays", () => {
      const stream = sse([
        {
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 5,
              speed: "fast",
              server_tool_use: { web_search_requests: 0 },
            },
          },
        },
        {
          type: "message_delta",
          usage: { output_tokens: 9, server_tool_use: tools, speed: null },
        },
        { type: "message_stop" },
      ]);
      expect(metered("text/event-stream", [stream])).toMatchObject({
        speed: "fast",
        ...tools,
        estimated: false,
      });
    });

    test("an answer that names no speed takes the request's, and a request that names none is standard", () => {
      const answer = JSON.stringify({
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 2 },
      });
      const fastRequest = encoder.encode(
        JSON.stringify({ model: "claude-opus-5", speed: "fast" }),
      );
      const meter = usageMeter("application/json");
      meter.observe(encoder.encode(answer));
      expect(meter.result(fastRequest).speed).toBe("fast");
      expect(metered("application/json", [answer]).speed).toBe("standard");
      expect(requestEstimate(fastRequest)).toMatchObject({
        speed: "fast",
        web_search_requests: 0,
        estimated: true,
      });
    });

    test("the answer's speed wins over the request's", () => {
      const answer = JSON.stringify({
        model: "claude-opus-4-6",
        usage: { input_tokens: 1, output_tokens: 2, speed: "standard" },
      });
      const meter = usageMeter("application/json");
      meter.observe(encoder.encode(answer));
      expect(
        meter.result(encoder.encode(JSON.stringify({ speed: "fast" }))).speed,
      ).toBe("standard");
    });

    test("a speed that is not a name is reported as unknown, never as standard", () => {
      for (const speed of [7, "", "x".repeat(65), { fast: true }]) {
        const answer = JSON.stringify({
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 2, speed },
        });
        expect(metered("application/json", [answer]).speed).toBe("unknown");
      }
    });

    test("a stream cut before its final count charges every search result it delivered (Codex R2)", () => {
      const result = (content: unknown) => ({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content,
        },
      });
      const stream = sse([
        {
          type: "message_start",
          message: { model: "claude-opus-5", usage: { input_tokens: 5 } },
        },
        result([{ type: "web_search_result", url: "https://a.test" }]),
        result([]),
        result({
          type: "web_search_tool_result_error",
          error_code: "unavailable",
        }),
      ]);
      expect(metered("text/event-stream", [stream])).toMatchObject({
        web_search_requests: 2,
        estimated: true,
      });
    });

    test("a search result too long to parse is still counted, split or whole (Codex R3)", () => {
      const huge = sse([
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                encrypted_content: "x".repeat(300 * 1024),
              },
            ],
          },
        },
      ]);
      const head = sse([
        {
          type: "message_start",
          message: { model: "claude-opus-5", usage: { input_tokens: 5 } },
        },
      ]);
      expect(
        metered("text/event-stream", [head, huge]).web_search_requests,
      ).toBe(1);
      expect(
        metered("text/event-stream", [
          head,
          huge.slice(0, 1000),
          huge.slice(1000, 280 * 1024),
          huge.slice(280 * 1024),
        ]).web_search_requests,
      ).toBe(1);
    });

    test("a stream cut short keeps the tool counts it saw", () => {
      const stream = sse([
        {
          type: "message_start",
          message: { model: "claude-opus-5", usage: { input_tokens: 5 } },
        },
        { type: "message_delta", usage: { server_tool_use: tools } },
      ]);
      expect(metered("text/event-stream", [stream])).toMatchObject({
        ...tools,
        estimated: true,
      });
    });
  });
});
