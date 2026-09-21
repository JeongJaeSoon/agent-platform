import { z } from "zod/v4";

import {
  apiErrorCodeSchema,
  receiptIdSchema,
  requestIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
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
export const receiptTargetSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: turnIdSchema.nullable(),
  request_id: requestIdSchema.nullable(),
});
export const receiptErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
});
export const receiptSchema = z.object({
  id: receiptIdSchema,
  operation: receiptOperationSchema,
  target_ref: receiptTargetSchema,
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
export type ReceiptTarget = z.infer<typeof receiptTargetSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type GetReceiptResponse = z.infer<typeof getReceiptResponseSchema>;
export type ReceiptAcceptedResponse = z.infer<
  typeof receiptAcceptedResponseSchema
>;
export type TerminateReceiptResult = z.infer<
  typeof terminateReceiptResultSchema
>;
