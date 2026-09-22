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
export const receiptSessionTargetSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: turnIdSchema.nullable(),
  request_id: requestIdSchema.nullable(),
});
// Mutations outside a session — invites, agents, releases, dispatches, memory,
// routines — name their resource instead (Codex B03). Each route adds its own
// `operation` value in its own ticket; the vocabulary here stays session-only
// until one does.
export const receiptResourceTargetSchema = z.object({
  resource: resourceRefSchema,
  workspace_id: workspaceIdSchema.nullable(),
});
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
  result: z.unknown().nullable(),
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
