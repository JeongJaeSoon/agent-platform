import { z } from "zod";

import {
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";
import { receiptStatusSchema } from "./receipt.ts";

export const SESSION_STATUS_VALUES = [
  "queued",
  "running",
  "needs_input",
  "idle",
  "failed",
  "stopped",
] as const;
export const ADMISSION_STATE_VALUES = [
  "active",
  "pausing",
  "paused",
  "resuming",
  "stopping",
  "stopped",
  "recovery_required",
  "closed",
] as const;
export const TURN_STATUS_VALUES = [
  "queued",
  "running",
  "needs_input",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
] as const;
export const TERMINAL_TURN_STATUS_VALUES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
] as const;
export const ATTEMPT_STATE_VALUES = [
  "allocated",
  "starting",
  "running",
  "draining",
  "exited",
  "lost",
] as const;
export const EXECUTION_STATE_VALUES = [
  "pending",
  "running",
  "suspended",
  "terminating",
  "terminated",
  "unknown",
] as const;
export const RUNTIME_KIND_VALUES = [
  "claude_agent_sdk",
  "codex_app_server",
  "pi_coding_agent",
] as const;
export const EXECUTION_BACKEND_VALUES = [
  "local_docker",
  "eks_job",
  "lambda_microvm",
] as const;
export const PERMISSION_MODE_VALUES = [
  "default",
  "acceptEdits",
  "dontAsk",
  "plan",
] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUS_VALUES);
export const admissionStateSchema = z.enum(ADMISSION_STATE_VALUES);
export const turnStatusSchema = z.enum(TURN_STATUS_VALUES);
export const terminalTurnStatusSchema = z.enum(TERMINAL_TURN_STATUS_VALUES);
export const attemptStateSchema = z.enum(ATTEMPT_STATE_VALUES);
export const executionStateSchema = z.enum(EXECUTION_STATE_VALUES);
export const runtimeKindSchema = z.enum(RUNTIME_KIND_VALUES);
export const executionBackendSchema = z.enum(EXECUTION_BACKEND_VALUES);
export const permissionModeSchema = z.enum(PERMISSION_MODE_VALUES);

export const sessionRuntimeSchema = z.object({
  kind: runtimeKindSchema,
  version: z.string().min(1),
  profile_id: z.string().min(1),
});
export const executionObservationSchema = z.object({
  backend: executionBackendSchema,
  state: executionStateSchema,
  observed_at: timestampSchema.nullable(),
});
export const sessionAttentionSchema = z.object({
  code: z.enum(["PAUSE_BLOCKED"]),
  reason: z.string().min(1),
});
export const sessionDurabilitySchema = z.object({
  last_transcript_persisted_at: timestampSchema.nullable(),
  checkpoint_committed_at: timestampSchema.nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  last_completed_turn_id: turnIdSchema.nullable(),
  last_checkpointed_turn_id: turnIdSchema.nullable(),
  checkpoint_pending_reason: z.string().min(1).nullable(),
});

export const sessionSummarySchema = z.object({
  id: sessionIdSchema,
  revision: revisionSchema,
  admission_state: admissionStateSchema,
  status: sessionStatusSchema,
  runtime: sessionRuntimeSchema,
  repository_id: z.string().min(1),
  current_turn_id: turnIdSchema.nullable(),
  queued_turn_count: z.number().int().nonnegative(),
  last_event_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export const sessionDetailSchema = sessionSummarySchema.extend({
  execution: executionObservationSchema.nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  pending_request_count: z.number().int().nonnegative(),
  attention: sessionAttentionSchema.nullable(),
  durability: sessionDurabilitySchema,
});

export const MESSAGE_MAX_BYTES = 32 * 1024;
export const REQUEST_BODY_MAX_BYTES = 64 * 1024;
export const messageTextSchema = z
  .string()
  .min(1)
  .max(MESSAGE_MAX_BYTES)
  .refine(
    (text) => new TextEncoder().encode(text).length <= MESSAGE_MAX_BYTES,
    `Message exceeds ${MESSAGE_MAX_BYTES} UTF-8 bytes`,
  );

export const createSessionRequestSchema = z
  .object({
    profile_id: z.string().min(1),
    repository_id: z.string().min(1),
    message: messageTextSchema,
  })
  .strict();
export const createSessionResponseSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: turnIdSchema,
  receipt_id: receiptIdSchema,
  receipt_status: receiptStatusSchema,
  status: sessionStatusSchema,
});
export const listSessionsQuerySchema = paginationQuerySchema.extend({
  status: sessionStatusSchema.optional(),
});
export const listSessionsResponseSchema = pageSchema(sessionSummarySchema);
export const getSessionResponseSchema = sessionDetailSchema;

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type AdmissionState = z.infer<typeof admissionStateSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type TerminalTurnStatus = z.infer<typeof terminalTurnStatusSchema>;
export type AttemptState = z.infer<typeof attemptStateSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export type ExecutionBackend = z.infer<typeof executionBackendSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>;
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;
export type SessionAttention = z.infer<typeof sessionAttentionSchema>;
export type SessionDurability = z.infer<typeof sessionDurabilitySchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;
