import { describe, expect, test } from "bun:test";
import { usageMeter } from "./usage.ts";

const encoder = new TextEncoder();

function metered(contentType: string, chunks: string[]) {
  const meter = usageMeter(contentType);
  for (const chunk of chunks) meter.observe(encoder.encode(chunk));
  return meter.result();
}

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

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
    });
  });

  test("takes the input side from message_start and the last message_delta's running totals", () => {
    const stream = sse([
      {
        type: "message_start",
        message: {
          model: "claude-sonnet-4-5",
          content: [],
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 40,
          },
        },
      },
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
    // Split mid-line and mid-character to show lines are rejoined.
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
    });
  });

  test("a stream cut after message_start still counts its input", () => {
    const stream = sse([
      {
        type: "message_start",
        message: { model: "m", usage: { input_tokens: 9, output_tokens: 1 } },
      },
    ]);
    expect(metered("text/event-stream", [stream])).toMatchObject({
      model: "m",
      input_tokens: 9,
      output_tokens: 1,
    });
  });

  test("an answer with no usage, or no model, reports nothing", () => {
    expect(metered("application/json", ['{"id":"msg_1"}'])).toBeNull();
    expect(metered("application/json", ["not json"])).toBeNull();
    expect(metered("text/event-stream", [sse([{ type: "ping" }])])).toBeNull();
  });

  test("a huge content line is skipped without being held", () => {
    const big = `data: ${"x".repeat(300 * 1024)}\n\n`;
    const tail = sse([{ type: "message_delta", usage: { output_tokens: 3 } }]);
    const head = sse([
      { type: "message_start", message: { model: "m", usage: {} } },
    ]);
    expect(
      metered("text/event-stream", [
        head,
        big.slice(0, 1000),
        big.slice(1000),
        tail,
      ]),
    ).toMatchObject({ model: "m", output_tokens: 3 });
  });
});
