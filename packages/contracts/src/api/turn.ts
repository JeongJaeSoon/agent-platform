import { z } from "zod";

import {
  attemptIdSchema,
  epochSchema,
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";
import { receiptStatusSchema } from "./receipt.ts";
import {
  attemptStateSchema,
  messageTextSchema,
  turnStatusSchema,
} from "./session.ts";

export const turnSourceSchema = z.enum(["slack", "web", "api"]);

export const sessionMessageSchema = z
  .object({ message: messageTextSchema })
  .strict();
export const postSessionMessageRequestSchema = sessionMessageSchema.extend({
  mode: z.literal("enqueue").default("enqueue"),
});
export const postSessionMessageResponseSchema = z.object({
  turn_id: turnIdSchema,
  receipt_id: receiptIdSchema,
  receipt_status: receiptStatusSchema,
});

export const attemptSummarySchema = z.object({
  attempt_id: attemptIdSchema,
  state: attemptStateSchema,
  lease_epoch: epochSchema,
  execution_generation: epochSchema,
  started_at: timestampSchema.nullable(),
  ended_at: timestampSchema.nullable(),
  profile_id: z.string().min(1).nullable().meta({
    description:
      "The profile the attempt ran: the session's when the attempt claimed it. A profile change reaches the next attempt, so this is what a turn ran on. Null for an attempt from before it was recorded.",
  }),
});
export const turnSummarySchema = z.object({
  turn_id: turnIdSchema,
  session_id: sessionIdSchema,
  status: turnStatusSchema.meta({
    description:
      "needs_input is derived when read, as for the session: a running turn with a pending request a client can still answer.",
  }),
  message: z.string(),
  source: turnSourceSchema.nullable().meta({
    description:
      "Where the instruction came from: `slack` (a mention, DM or thread reply), `web` (the console) or `api` (an API key). Null for a turn from before it was recorded.",
  }),
  author_name: z.string().nullable().meta({
    description:
      "Display name of the person who sent the instruction. Null for an API key no person created, or a turn from before it was recorded.",
  }),
  terminal_reason: z.string().min(1).nullable(),
  checkpoint_revision: revisionSchema.nullable().meta({
    description:
      "The newest checkpoint this turn committed that a restore can still reach. A revision garbage collection removed, or one a start_fresh recovery decision retired, is not reported; null when none is left.",
  }),
  created_at: timestampSchema,
  started_at: timestampSchema.nullable(),
  ended_at: timestampSchema.nullable(),
});
export const turnDetailSchema = turnSummarySchema.extend({
  result: z.unknown().nullable(),
  usage: z.unknown().nullable(),
  attempts: z.array(attemptSummarySchema),
});
export const listTurnsQuerySchema = paginationQuerySchema;
export const listTurnsResponseSchema = pageSchema(turnSummarySchema);
export const getTurnResponseSchema = turnDetailSchema;

export const unassignedSessionSignalSchema = z.undefined();

export type SessionMessage = z.infer<typeof sessionMessageSchema>;
export type PostSessionMessageRequest = z.infer<
  typeof postSessionMessageRequestSchema
>;
export type PostSessionMessageResponse = z.infer<
  typeof postSessionMessageResponseSchema
>;
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;
export type TurnSummary = z.infer<typeof turnSummarySchema>;
export type TurnSource = z.infer<typeof turnSourceSchema>;
export type TurnDetail = z.infer<typeof turnDetailSchema>;
export type ListTurnsQuery = z.infer<typeof listTurnsQuerySchema>;
export type ListTurnsResponse = z.infer<typeof listTurnsResponseSchema>;
export type GetTurnResponse = z.infer<typeof getTurnResponseSchema>;
export type UnassignedSessionSignal = z.infer<
  typeof unassignedSessionSignalSchema
>;
