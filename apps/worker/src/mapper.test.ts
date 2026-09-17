import { describe, expect, test } from "bun:test";
import { sseEventSchema } from "@claude-session-platform/contracts";

import { frameFromNativeMessage, pendingRequestEvent } from "./mapper.ts";

describe("native SDK message mapping", () => {
  test("projects assistant blocks and preserves correlation fields", () => {
    const frame = frameFromNativeMessage(
      {
        type: "assistant",
        uuid: "message-uuid",
        parent_tool_use_id: "parent-tool-id",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", id: "tool-id", name: "Read", input: {} },
          ],
        },
      },
      "correlation-1",
      "cursor",
    );
    expect(frame.events.map((item) => item.event)).toEqual([
      "assistant",
      "tool_use",
    ]);
    expect(frame.envelope.correlation_id).toBe("correlation-1");
    expect(JSON.stringify(frame)).toContain("message-uuid");
    expect(JSON.stringify(frame)).toContain("parent-tool-id");
    expect(JSON.stringify(frame)).toContain("tool-id");
    for (const item of frame.events) {
      expect(sseEventSchema.parse(item)).toEqual(item);
    }
  });

  test("keeps partials only in the native envelope and versions unknown events", () => {
    const partial = frameFromNativeMessage(
      { type: "stream_event", event: { type: "content_block_delta" } },
      "correlation-2",
      "partial",
    );
    expect(partial.events).toEqual([]);
    expect(partial.envelope.message.type).toBe("stream_event");

    const unknown = frameFromNativeMessage(
      { type: "future_event", uuid: "future-uuid" },
      "correlation-3",
      "future",
    );
    expect(unknown.events[0]).toEqual(
      expect.objectContaining({
        event: "system",
        data: expect.objectContaining({
          subtype: "sdk_event",
          native_type: "future_event",
          schema_version: "sdk-envelope/v1",
        }),
      }),
    );
  });

  test("redacts credentials and host paths without losing request IDs", () => {
    const credentialMarker = ["s", "k", "-ant-api03-marker-value"].join("");
    const frame = frameFromNativeMessage(
      {
        type: "system",
        subtype: "init",
        cwd: "/private/tenant",
        authorization: "Bearer private-token",
        diagnostic: credentialMarker,
        request_id: "request-1",
        tool_use_id: "tool-1",
      },
      "correlation-4",
      "init",
    );
    const serialized = JSON.stringify(frame);
    expect(serialized).not.toContain("/private/tenant");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain(credentialMarker);
    expect(serialized).toContain("request-1");
    expect(serialized).toContain("tool-1");
  });

  test("projects permission and question requests with stable correlation", () => {
    const event = pendingRequestEvent(
      {
        input: { command: "pwd" },
        kind: "permission",
        requestId: "request-2",
        tool: "Bash",
        toolUseId: "tool-2",
      },
      "question",
    );
    expect(event.data).toEqual(
      expect.objectContaining({
        request_id: "request-2",
        tool_use_id: "tool-2",
      }),
    );
  });
});
