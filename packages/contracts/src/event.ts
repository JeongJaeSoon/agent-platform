import { z } from "zod";

import { sessionStatusSchema } from "./session.ts";

export const opaqueCursorSchema = z.string().min(1);
export const lastEventIdHeadersSchema = z.object({
  "last-event-id": opaqueCursorSchema.optional(),
});

const requiredUnknownSchema = z
  .unknown()
  .refine((value) => value !== undefined, "Required");
const assistantMessagePayloadSchema = z.object({
  type: z.literal("assistant"),
  message: requiredUnknownSchema,
});

export const sseEventSchema = z.discriminatedUnion("event", [
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("system"),
    data: z.object({ type: z.literal("system") }).passthrough(),
  }),
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("assistant"),
    data: assistantMessagePayloadSchema,
  }),
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("tool_use"),
    data: assistantMessagePayloadSchema,
  }),
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("tool_result"),
    data: requiredUnknownSchema,
  }),
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("question"),
    data: z.object({
      request_id: z.string().min(1),
      kind: z.enum(["permission", "question"]),
      tool: z.string().min(1).optional(),
      input: requiredUnknownSchema,
    }),
  }),
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("result"),
    data: z
      .object({
        type: z.literal("result"),
        subtype: z.string().min(1),
        session_id: z.string().min(1),
        usage: requiredUnknownSchema.optional(),
      })
      .passthrough(),
  }),
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("status"),
    data: z.object({ status: sessionStatusSchema }).passthrough(),
  }),
  z.object({
    id: opaqueCursorSchema,
    event: z.literal("error"),
    data: z
      .object({
        message: z.string().min(1),
        code: z.string().min(1).optional(),
      })
      .passthrough(),
  }),
]);

export type OpaqueCursor = z.infer<typeof opaqueCursorSchema>;
export type LastEventIdHeaders = z.infer<typeof lastEventIdHeadersSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
