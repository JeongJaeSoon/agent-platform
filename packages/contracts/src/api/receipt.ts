import { z } from "zod";

import {
  receiptActorSchema,
  resourceRefSchema,
} from "../domain/authorization.ts";
import {
  apiErrorCodeSchema,
  receiptIdSchema,
  requestIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const RECEIPT_STATUS_VALUES = [
  "accepted",
  "succeeded",
  "failed",
  "unknown",
] as const;
export const RECEIPT_OPERATION_VALUES = [
  "create_session",
  "append_message",
  "answer",
  "interrupt",
  "pause",
  "terminate",
  "resume",
  "recovery_decision",
] as const;

export const receiptStatusSchema = z.enum(RECEIPT_STATUS_VALUES);
export const receiptOperationSchema = z.enum(RECEIPT_OPERATION_VALUES);
// The alpha shape, unchanged: every session operation still answers with
// exactly these three fields.
// Strict on both sides, so a target can only ever be one of the two: a value
// carrying both shapes would otherwise match the session branch and have its
// resource fields silently stripped. It also matches what the generated
// OpenAPI already promised (`additionalProperties: false`).
export const receiptSessionTargetSchema = z
  .object({
    session_id: sessionIdSchema,
    turn_id: turnIdSchema.nullable(),
    request_id: requestIdSchema.nullable(),
  })
  .strict();
// Mutations outside a session — invites, agents, releases, dispatches, memory,
// routines — name their resource instead (Codex B03). Each route adds its own
// `operation` value in its own ticket; the vocabulary here stays session-only
// until one does.
export const receiptResourceTargetSchema = z
  .object({
    resource: resourceRefSchema,
    workspace_id: workspaceIdSchema.nullable(),
  })
  .strict();
export const receiptTargetSchema = z.union([
  receiptSessionTargetSchema,
  receiptResourceTargetSchema,
]);
export const receiptErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
});
export const receiptSchema = z.object({
  id: receiptIdSchema,
  operation: receiptOperationSchema,
  target_ref: receiptTargetSchema,
  // Who asked for this. Optional until 94S-150 adds the column; alpha rows
  // written before it have no actor to report (Codex B19).
  actor: receiptActorSchema.optional(),
  status: receiptStatusSchema,
  // Input receipts keep the acceptance response for good, because a retry
  // with the same Idempotency-Key replays exactly that body (api.md, common
  // rules). Every writer that settles one — finalize, execution gone,
  // terminate, recovery decisions — changes `status` and `error` only.
  result: z.unknown().nullable().meta({
    description:
      "For create_session and append_message: the acceptance response exactly as first returned, never rewritten; its receipt_status and status are acceptance-time values. The current outcome is this receipt's status and error; the turn's result is read from GET /v1/sessions/{session_id}/turns/{turn_id} using target_ref.",
  }),
  error: receiptErrorSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export const getReceiptResponseSchema = receiptSchema;

export const receiptAcceptedResponseSchema = z.object({
  receipt_id: receiptIdSchema,
  receipt_status: receiptStatusSchema,
});

export const terminateReceiptResultSchema = z.object({
  execution_gone: z.boolean(),
  checkpoint_revision: revisionSchema.nullable(),
  unconfirmed_turn_id: turnIdSchema.nullable(),
  // A kill removes the execution; whatever it already did outside (commits,
  // pushes, API calls) stays done. The receipt says so instead of letting
  // "succeeded" read as a rollback.
  external_effects_reverted: z.literal(false),
});

export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;
export type ReceiptOperation = z.infer<typeof receiptOperationSchema>;
export type ReceiptSessionTarget = z.infer<typeof receiptSessionTargetSchema>;
export type ReceiptResourceTarget = z.infer<typeof receiptResourceTargetSchema>;
export type ReceiptTarget = z.infer<typeof receiptTargetSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type GetReceiptResponse = z.infer<typeof getReceiptResponseSchema>;
export type ReceiptAcceptedResponse = z.infer<
  typeof receiptAcceptedResponseSchema
>;
export type TerminateReceiptResult = z.infer<
  typeof terminateReceiptResultSchema
>;
