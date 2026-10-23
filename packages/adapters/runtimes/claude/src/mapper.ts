import { type SessionEvent, sessionEventSchema } from "@werft-ai/contracts";

import {
  type AgentFrame,
  type NativeEnvelope,
  type NativeSdkMessage,
  RUNTIME_EVENT_SCHEMA,
  type RuntimeEvent,
  type RuntimeEventBody,
} from "@werft-ai/runtime-core";

import { CLAUDE_AGENT_SDK_VERSION } from "./config.ts";
import { endedByAbort } from "./run.ts";

const REDACTED = "[REDACTED]";
// Paths are not secrets: an approval has to say which file it touches.
const SENSITIVE_KEY =
  /authorization|cookie|credential|secret|password|api[_-]?key|auth[_-]?token|(^|_)home$/i;
const SENSITIVE_VALUE =
  /\bBearer\s+\S+|\b(?:s[k]-ant(?:-api\d+)?|csp)[_-][A-Za-z0-9_-]+/gi;
const SENSITIVE_NAME =
  /\b(?:authorization|cookie|credential|secret|password|api[-_ ]?key|auth[-_ ]?token|access[-_ ]?key|private[-_ ]?key)\b\s*([:=])[ \t]*/gi;
// One plain word, or one quoted string with nothing to expand.
const PLAIN_VALUE = /"[^"\\$`\n]*"|'[^'\n]*'|[^\s"'\\$`&;|<>()]+/y;
const VALUE_END = /[\s&;|)]|$/y;

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

/**
 * Turns the driver's frames into runtime events. Every frame yields its v1
 * projection first, so the public stream keeps the order it has today, then
 * what the worker reads of the same message.
 */
export class ClaudeEventMapper {
  private sequence = 0;

  constructor(private readonly correlationId: string) {}

  fromFrame(frame: AgentFrame): RuntimeEvent[] {
    const message = frame.envelope.message;
    const bodies: RuntimeEventBody[] = [
      { type: "v1.projected", events: frame.events },
      ...normalized(message),
    ];
    return bodies.map((body) => this.stamp(body));
  }

  fromNative(native: NativeSdkMessage, cursor: string): RuntimeEvent[] {
    return this.fromFrame(
      frameFromNativeMessage(native, this.correlationId, cursor),
    );
  }

  stamp(body: RuntimeEventBody): RuntimeEvent {
    const sequence = this.sequence++;
    return {
      ...body,
      correlationId: this.correlationId,
      id: `${this.correlationId}:${sequence}`,
      schema: RUNTIME_EVENT_SCHEMA,
      sequence,
    };
  }
}

function normalized(message: NativeSdkMessage): RuntimeEventBody[] {
  if (message.type === "assistant") {
    return [
      {
        type: "message",
        role: "assistant",
        ...(typeof message.error === "string" ? { error: message.error } : {}),
      },
    ];
  }
  if (message.type === "system" && message.subtype === "api_retry") {
    return [
      {
        type: "runtime.warning",
        code: "api_retry",
        ...(typeof message.error === "string"
          ? { message: message.error }
          : {}),
        status:
          typeof message.error_status === "number"
            ? message.error_status
            : null,
      },
    ];
  }
  if (message.type === "system" && message.subtype === "mirror_error") {
    return [
      {
        type: "runtime.warning",
        code: "mirror_error",
        ...(typeof message.error === "string" && message.error.length > 0
          ? { message: message.error }
          : {}),
      },
    ];
  }
  if (message.type !== "result") return [];
  return [
    {
      type: "turn.ended",
      abortedByStop: endedByAbort(message),
      ...(typeof message.total_cost_usd === "number"
        ? { costTotalUsd: message.total_cost_usd }
        : {}),
      detail: {
        apiErrorStatus: message.api_error_status,
        isError: message.is_error,
        stopReason: message.stop_reason,
        subtype: message.subtype,
        terminalReason: message.terminal_reason,
      },
      ...(typeof message.session_id === "string"
        ? { engineSessionId: message.session_id }
        : {}),
      inputs: attributedUuids(message),
      usage: message.usage,
    },
  ];
}

/** The inputs a result says it consumed, the way TurnLedger reads them. */
function attributedUuids(message: NativeSdkMessage): string[] {
  const listed = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const last =
    typeof message.user_message_uuid === "string"
      ? [message.user_message_uuid]
      : [];
  return [...new Set([...listed, ...last])];
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
    return hideNamedValues(value.replace(SENSITIVE_VALUE, REDACTED));
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

// A `name=value` loses just its value when the value visibly ends. Anything
// else — `name: value`, escapes, `$'…'`, concatenated quotes, a value on the
// next line — hides the whole text.
function hideNamedValues(text: string): string {
  let shown = "";
  let from = 0;
  for (const name of text.matchAll(SENSITIVE_NAME)) {
    if (name.index < from) continue;
    if (name[1] === ":") return REDACTED;
    const start = name.index + name[0].length;
    PLAIN_VALUE.lastIndex = start;
    const value = PLAIN_VALUE.exec(text);
    if (value === null) return REDACTED;
    const end = start + value[0].length;
    VALUE_END.lastIndex = end;
    if (!VALUE_END.test(text)) return REDACTED;
    shown += text.slice(from, start) + REDACTED;
    from = end;
  }
  return shown + text.slice(from);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
