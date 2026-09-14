export type RecordedRequest = {
  readonly body: Record<string, unknown>;
  readonly path: string;
};

export type FakeAnthropicServer = {
  readonly requests: RecordedRequest[];
  readonly url: string;
  stop(): void;
};

export type FakeReply =
  | string
  | {
      readonly id: string;
      readonly input: Record<string, unknown>;
      readonly name: string;
      readonly type: "tool_use";
    };

export function startFakeAnthropicServer(
  reply: (request: RecordedRequest, index: number) => FakeReply,
): FakeAnthropicServer {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/messages")) {
        return new Response("not found", { status: 404 });
      }
      const recorded = {
        body: (await request.json()) as Record<string, unknown>,
        path: url.pathname,
      };
      requests.push(recorded);
      return streamResponse(reply(recorded, requests.length - 1));
    },
  });
  return {
    requests,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}`,
  };
}

function streamResponse(reply: FakeReply): Response {
  const message = {
    content: [],
    id: `msg_${crypto.randomUUID()}`,
    model: "claude-sonnet-4-5",
    role: "assistant",
    stop_reason: null,
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const contentBlock =
    typeof reply === "string"
      ? { type: "text", text: "" }
      : { type: "tool_use", id: reply.id, name: reply.name, input: {} };
  const delta =
    typeof reply === "string"
      ? { type: "text_delta", text: reply }
      : { type: "input_json_delta", partial_json: JSON.stringify(reply.input) };
  const events = [
    { type: "message_start", message },
    {
      type: "content_block_start",
      index: 0,
      content_block: contentBlock,
    },
    {
      type: "content_block_delta",
      index: 0,
      delta,
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: typeof reply === "string" ? "end_turn" : "tool_use",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      headers: {
        "content-type": "text/event-stream",
        "request-id": `req_${crypto.randomUUID()}`,
      },
    },
  );
}
