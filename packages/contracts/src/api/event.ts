import { z } from "zod";

import {
  attemptIdSchema,
  opaqueCursorSchema,
  requestIdSchema,
  requiredUnknownSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";
import { admissionStateSchema, SESSION_STATUS_VALUES } from "./session.ts";

export const SESSION_EVENT_NAMES = [
  "system",
  "assistant",
  "tool_use",
  "tool_result",
  "question",
  "result",
  "status",
  "error",
] as const;
export const SSE_SCHEMA_VERSION = 1;
// A status event reports the session's projected status, or a control step
// in progress that no stored status names: an interrupt the worker has taken
// and is waiting on the engine's terminal for.
export const STATUS_EVENT_PHASE_VALUES = [
  ...SESSION_STATUS_VALUES,
  "interrupting",
] as const;
export const statusEventPhaseSchema = z.enum(STATUS_EVENT_PHASE_VALUES);

const assistantMessagePayloadSchema = z.object({
  type: z.literal("assistant"),
  message: requiredUnknownSchema,
  parent_tool_use_id: z.string().min(1).nullable().optional(),
});

// Per-kind payloads: the worker projects native SDK messages into these and the
// server wraps them into the public envelope.
export const sessionEventVariants = {
  system: z.object({
    event: z.literal("system"),
    data: z.looseObject({ type: z.literal("system") }),
  }),
  assistant: z.object({
    event: z.literal("assistant"),
    data: assistantMessagePayloadSchema,
  }),
  tool_use: z.object({
    event: z.literal("tool_use"),
    data: assistantMessagePayloadSchema,
  }),
  tool_result: z.object({
    event: z.literal("tool_result"),
    data: requiredUnknownSchema,
  }),
  question: z.object({
    event: z.literal("question"),
    data: z.object({
      request_id: requestIdSchema,
      tool_use_id: z.string().min(1),
      kind: z.enum(["permission", "question"]),
      tool: z.string().min(1).optional(),
      input: requiredUnknownSchema,
    }),
  }),
  result: z.object({
    event: z.literal("result"),
    data: z.looseObject({
      type: z.literal("result"),
      subtype: z.string().min(1),
      session_id: z.string().min(1),
      usage: requiredUnknownSchema.optional(),
    }),
  }),
  status: z.object({
    event: z.literal("status"),
    data: z.looseObject({
      phase: statusEventPhaseSchema,
      admission_state: admissionStateSchema.optional(),
    }),
  }),
  error: z.object({
    event: z.literal("error"),
    data: z.looseObject({
      message: z.string().min(1),
      code: z.string().min(1).optional(),
    }),
  }),
} as const;

const v = sessionEventVariants;
type EventVariant =
  (typeof sessionEventVariants)[keyof typeof sessionEventVariants];

const sseEnvelopeSchema = z.object({
  schema_version: z.literal(SSE_SCHEMA_VERSION),
  session_id: sessionIdSchema,
  turn_id: turnIdSchema.nullable(),
  attempt_id: attemptIdSchema.nullable(),
  occurred_at: timestampSchema,
});

function record<V extends EventVariant>(variant: V) {
  return variant.extend({ id: opaqueCursorSchema });
}
function frame<V extends EventVariant>(variant: V) {
  return z.object({
    id: opaqueCursorSchema,
    event: variant.shape.event,
    data: sseEnvelopeSchema.extend({ data: variant.shape.data }),
  });
}

export const sessionEventPayloadSchema = z.discriminatedUnion("event", [
  v.system,
  v.assistant,
  v.tool_use,
  v.tool_result,
  v.question,
  v.result,
  v.status,
  v.error,
]);
// Stored/projected event: server-assigned cursor plus kind and payload.
export const sessionEventSchema = z.discriminatedUnion("event", [
  record(v.system),
  record(v.assistant),
  record(v.tool_use),
  record(v.tool_result),
  record(v.question),
  record(v.result),
  record(v.status),
  record(v.error),
]);
// Public SSE frame: `id` is the replay cursor, `data` is the versioned envelope.
export const sseEventSchema = z.discriminatedUnion("event", [
  frame(v.system),
  frame(v.assistant),
  frame(v.tool_use),
  frame(v.tool_result),
  frame(v.question),
  frame(v.result),
  frame(v.status),
  frame(v.error),
]);

// A stored row the contract does not read (written before every writer was
// held to it, 94S-283) would otherwise stop each read at that row for good:
// no page past it could be served and the cursor could never move on. It
// reads instead as an `error` event under its own cursor. This code is not
// terminal; the session's state is read from the session, not from here.
// The flip side: a reader cannot tell such a row from one a newer writer
// stored, so widening this contract (a new kind or enum value) must reach
// every reader before any writer uses it.
export const UNREADABLE_EVENT_CODE = "EVENT_UNREADABLE";

export function readStoredEvent(
  event: string,
  data: unknown,
): { payload: SessionEventPayload; readable: boolean } {
  const parsed = sessionEventPayloadSchema.safeParse({ event, data });
  if (parsed.success) return { payload: parsed.data, readable: true };
  return {
    payload: {
      event: "error",
      data: {
        message: "This event could not be read and was replaced",
        code: UNREADABLE_EVENT_CODE,
      },
    },
    readable: false,
  };
}

export type SessionEventName = (typeof SESSION_EVENT_NAMES)[number];
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
