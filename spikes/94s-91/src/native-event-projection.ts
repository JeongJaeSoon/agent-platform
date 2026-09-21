import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type SessionEvent,
  sessionEventSchema,
} from "../../../packages/contracts/src/api/event";

export type PendingRequestProjection = {
  input: unknown;
  kind: "permission" | "question";
  requestId: string;
  tool?: string;
  toolUseId: string;
};

export function projectSdkMessage(
  message: SDKMessage,
  cursor: string,
): SessionEvent[] {
  if (message.type === "assistant") {
    if (message.error !== undefined) {
      return [
        parseEvent(cursor, "error", {
          code: message.error,
          message: "Agent SDK assistant request failed",
        }),
      ];
    }
    return message.message.content.map((block) =>
      parseEvent(cursor, block.type === "tool_use" ? "tool_use" : "assistant", {
        message: { ...message.message, content: [block] },
        parent_tool_use_id: message.parent_tool_use_id,
        type: "assistant",
      }),
    );
  }
  if (message.type === "user" && Array.isArray(message.message.content)) {
    return message.message.content
      .filter((block) => block.type === "tool_result")
      .map((block) => parseEvent(cursor, "tool_result", block));
  }
  if (message.type === "result") {
    return [
      parseEvent(cursor, "result", {
        is_error: message.is_error,
        session_id: message.session_id,
        stop_reason: message.stop_reason,
        subtype: message.subtype,
        terminal_reason: message.terminal_reason,
        type: "result",
        usage: message.usage,
      }),
    ];
  }
  if (message.type === "stream_event") return [];
  if (message.type === "system" && message.subtype === "mirror_error") {
    return [
      parseEvent(cursor, "error", {
        code: "mirror_error",
        message: "Agent SDK transcript mirror failed",
      }),
    ];
  }
  if (message.type === "system") {
    return [
      parseEvent(cursor, "system", {
        subtype: message.subtype,
        type: "system",
      }),
    ];
  }
  return [];
}

export function projectPendingRequest(
  pending: PendingRequestProjection,
  cursor: string,
): SessionEvent {
  return parseEvent(cursor, "question", {
    input: pending.input,
    kind: pending.kind,
    request_id: pending.requestId,
    tool: pending.tool,
    tool_use_id: pending.toolUseId,
  });
}

export function projectStatus(
  status: "queued" | "running" | "needs_input" | "idle" | "stopped" | "failed",
  cursor: string,
): SessionEvent {
  return parseEvent(cursor, "status", { phase: status });
}

function parseEvent(
  id: string,
  event: SessionEvent["event"],
  data: unknown,
): SessionEvent {
  return sessionEventSchema.parse({ id, event, data });
}
