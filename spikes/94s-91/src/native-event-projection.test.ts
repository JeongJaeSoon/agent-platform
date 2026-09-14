import { afterEach, describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createProbeContext,
  type FakeAnthropicServer,
  type ProbeContext,
  runSdkQuery,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "./harness.ts";
import {
  projectPendingRequest,
  projectSdkMessage,
  projectStatus,
} from "./native-event-projection";

let context: ProbeContext | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await context?.dispose();
  context = undefined;
  server = undefined;
});

describe("SDK native message to public SSE projection", () => {
  test("projects the eight stable public event kinds without leaking native init", () => {
    const assistant = sdkMessage({
      type: "assistant",
      error: undefined,
      parent_tool_use_id: "toolu_parent",
      message: {
        id: "msg_projection",
        content: [
          { type: "text", text: "visible" },
          {
            type: "tool_use",
            id: "toolu_projection",
            name: "Bash",
            input: { command: "true" },
          },
        ],
      },
    });
    const toolResult = sdkMessage({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_projection",
            content: "ok",
          },
        ],
      },
    });
    const result = sdkMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session_projection",
      stop_reason: "end_turn",
      terminal_reason: "completed",
      usage: {},
    });
    const system = sdkMessage({
      type: "system",
      subtype: "init",
      cwd: "/private/tenant/path",
      tools: ["SecretTool"],
    });
    const error = sdkMessage({
      type: "system",
      subtype: "mirror_error",
      error: "private backend detail",
    });
    const question = projectPendingRequest(
      {
        input: { command: "true" },
        kind: "permission",
        requestId: "request_projection",
        tool: "Bash",
        toolUseId: "toolu_projection",
      },
      "cursor_question",
    );

    const events = [
      ...projectSdkMessage(system, "cursor_system"),
      ...projectSdkMessage(assistant, "cursor_assistant"),
      ...projectSdkMessage(toolResult, "cursor_tool_result"),
      question,
      ...projectSdkMessage(result, "cursor_result"),
      projectStatus("running", "cursor_status"),
      ...projectSdkMessage(error, "cursor_error"),
    ];

    expect(events.map((event) => event.event).sort()).toEqual([
      "assistant",
      "error",
      "question",
      "result",
      "status",
      "system",
      "tool_result",
      "tool_use",
    ]);
    expect(JSON.stringify(events)).not.toContain("/private/tenant/path");
    expect(JSON.stringify(events)).not.toContain("SecretTool");
    expect(JSON.stringify(events)).not.toContain("private backend detail");
    expect(question.data).toEqual(
      expect.objectContaining({
        request_id: "request_projection",
        tool_use_id: "toolu_projection",
      }),
    );
  });

  test("retains partial stream frames only in the native envelope", () => {
    const partial = sdkMessage({
      type: "stream_event",
      event: { type: "content_block_delta" },
      parent_tool_use_id: null,
    });
    expect(projectSdkMessage(partial, "cursor_partial")).toEqual([]);
  });

  test("drops an unknown native variant from the stable public projection", () => {
    const unknown = sdkMessage({ type: "future_native_variant" });
    expect(projectSdkMessage(unknown, "cursor_unknown")).toEqual([]);
  });

  test("projects messages emitted by the actual SDK and Claude Code process", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply("Bash", { command: "true" }, "toolu_actual_projection")
        : textReply("actual projection complete"),
    );
    const messages = await runSdkQuery(
      context,
      server.url,
      "Request the projection fixture.",
      {
        canUseTool: async () => ({
          behavior: "deny",
          message: "projection fixture denial",
        }),
        tools: ["Bash"],
      },
    );
    const events = messages.flatMap((message, index) =>
      projectSdkMessage(message, `cursor_actual_${index}`),
    );

    expect(new Set(events.map((event) => event.event))).toEqual(
      new Set(["system", "tool_use", "tool_result", "assistant", "result"]),
    );
    expect(JSON.stringify(events)).toContain("toolu_actual_projection");
    expect(JSON.stringify(events)).toContain("actual projection complete");
  }, 30_000);
});

function sdkMessage(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}
