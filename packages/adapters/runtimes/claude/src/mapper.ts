import {
  type SessionEvent,
  sessionEventSchema,
} from "@agent-platform/contracts";

import type {
  AgentFrame,
  NativeEnvelope,
  NativeSdkMessage,
} from "@agent-platform/runtime-core";

import { CLAUDE_AGENT_SDK_VERSION } from "./config.ts";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /authorization|cookie|credential|secret|password|api[_-]?key|auth[_-]?token|(^|_)home$/i;
// Paths are not secrets: an approval has to say which file it touches.
const PATH_KEY = /^cwd$|(^|_)path$/i;
const SENSITIVE_VALUE =
  /\bBearer\s+\S+|\b(?:s[k]-ant(?:-api\d+)?|csp)[_-][A-Za-z0-9_-]+/gi;
const SENSITIVE_NAME = String.raw`\b(?:authorization|cookie|credential|secret|password|api[-_ ]?key|auth[-_ ]?token|access[-_ ]?key|private[-_ ]?key)\b\s*`;
// Only a `name=value` whose value is one plain word or one quoted string with
// nothing to expand loses just its value. Where the value's end is unclear
// (escapes, `$'…'`, concatenation, `name: value`, a value on the next line),
// the whole text goes.
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`(${SENSITIVE_NAME}=[ \t]*)(?:"[^"\\$\x60\n]*"|'[^'\n]*'|[^\s"'\\$\x60&;|<>()]+)(?=[\s&;|)]|$)`,
  "gi",
);
const SENSITIVE_NAME_LEFT = new RegExp(
  String.raw`${SENSITIVE_NAME}[:=](?![ \t]*\[REDACTED\])`,
  "i",
);

export function frameFromNativeMessage(
  message: NativeSdkMessage,
  correlationId: string,
  cursor: string,
): AgentFrame {
  const envelope: NativeEnvelope = {
    correlation_id: correlationId,
    message: sanitizeNativeMessage(message),
    schema_version: "sdk-envelope/v1",
    sdk_version: CLAUDE_AGENT_SDK_VERSION,
  };
  return {
    envelope,
    events: projectPublicEvents(envelope, cursor),
  };
}

export function sanitizeNativeMessage(
  message: NativeSdkMessage,
): NativeSdkMessage {
  return sanitizeValue(message) as NativeSdkMessage;
}

export function projectPublicEvents(
  envelope: NativeEnvelope,
  cursor: string,
): SessionEvent[] {
  const message = envelope.message;
  if (message.type === "assistant") {
    if (typeof message.error === "string") {
      return [
        event(cursor, "error", {
          code: message.error,
          message: "Agent SDK assistant request failed",
        }),
      ];
    }
    const nativeMessage = record(message.message);
    const content = Array.isArray(nativeMessage?.content)
      ? nativeMessage.content
      : [];
    return content.map((block, index) => {
      const safeBlock = record(block) ?? { type: "unknown" };
      return event(
        `${cursor}:${index}`,
        safeBlock.type === "tool_use" ? "tool_use" : "assistant",
        {
          type: "assistant",
          message: { ...nativeMessage, content: [safeBlock] },
          parent_tool_use_id:
            typeof message.parent_tool_use_id === "string"
              ? message.parent_tool_use_id
              : null,
        },
      );
    });
  }
  if (message.type === "user") {
    const nativeMessage = record(message.message);
    if (!Array.isArray(nativeMessage?.content)) return [];
    return nativeMessage.content.flatMap((block, index) => {
      const safeBlock = record(block);
      if (safeBlock?.type !== "tool_result") return [];
      return [event(`${cursor}:${index}`, "tool_result", safeBlock)];
    });
  }
  if (message.type === "result") {
    return [
      event(cursor, "result", {
        type: "result",
        subtype:
          typeof message.subtype === "string" ? message.subtype : "unknown",
        session_id:
          typeof message.session_id === "string"
            ? message.session_id
            : "unknown-session",
        is_error: message.is_error,
        stop_reason: message.stop_reason,
        terminal_reason: message.terminal_reason,
        usage: message.usage,
      }),
    ];
  }
  if (message.type === "stream_event") return [];
  if (message.type === "system" && message.subtype === "mirror_error") {
    return [
      event(cursor, "error", {
        code: "mirror_error",
        message: "Agent SDK transcript mirror failed",
      }),
    ];
  }
  if (message.type === "system") {
    return [
      event(cursor, "system", {
        type: "system",
        subtype:
          typeof message.subtype === "string" ? message.subtype : "unknown",
      }),
    ];
  }
  return [
    event(cursor, "system", {
      type: "system",
      subtype: "sdk_event",
      native_type: message.type,
      schema_version: envelope.schema_version,
      sdk_version: envelope.sdk_version,
      correlation_id: envelope.correlation_id,
    }),
  ];
}

export function pendingRequestEvent(
  request: {
    input: unknown;
    kind: "permission" | "question";
    requestId: string;
    tool?: string;
    toolUseId: string;
  },
  cursor: string,
): SessionEvent {
  return event(cursor, "question", {
    request_id: request.requestId,
    tool_use_id: request.toolUseId,
    kind: request.kind,
    tool: request.tool,
    input: sanitizeValue(request.input),
  });
}

function event(
  id: string,
  eventName: SessionEvent["event"],
  data: unknown,
): SessionEvent {
  return sessionEventSchema.parse({ id, event: eventName, data });
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") {
    const text = value.replace(SENSITIVE_VALUE, REDACTED);
    if (key !== undefined && PATH_KEY.test(key)) return text;
    const masked = text.replace(SENSITIVE_ASSIGNMENT, `$1${REDACTED}`);
    return SENSITIVE_NAME_LEFT.test(masked) ? REDACTED : masked;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeValue(childValue, childKey),
    ]),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
