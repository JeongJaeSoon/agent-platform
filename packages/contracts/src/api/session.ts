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
// Why a pause has not reached its safe boundary once the drain deadline has
// passed (api.md § 일시 중지와 저장 상태): a turn still running, a turn
// waiting on a question or approval, a transcript mirror that lost entries,
// or a drain that ended with no committed checkpoint covering the last turn
// that ran. Showing it kills nothing; terminate is the caller's to choose.
export const PAUSE_BLOCKED_REASON_VALUES = [
  "long_turn",
  "pending_request",
  "mirror_error",
  "checkpoint_unavailable",
] as const;
export const pauseBlockedReasonSchema = z.enum(PAUSE_BLOCKED_REASON_VALUES);
export const sessionAttentionSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("PAUSE_BLOCKED"),
    reason: pauseBlockedReasonSchema,
  }),
  // The session has spent SESSION_COST_LIMIT_USD, so no further turn is
  // dispatched; input is still queued (94S-131).
  z.object({
    code: z.literal("BUDGET_EXCEEDED"),
    reason: z.string().min(1),
  }),
  // A turn ran that no trusted checkpoint covers, so the next worker could
  // only start a new engine session without it (94S-288). The session is
  // held in recovery_required (or cannot be resumed from stopped) until an
  // operator decides: start_fresh continues without that context, close
  // ends the session.
  z.object({
    code: z.literal("CONTEXT_GAP"),
    last_ran_turn_id: turnIdSchema,
    checkpointed_turn_id: turnIdSchema.nullable(),
  }),
  // The catalog does not allow the session's profile and repository pair as
  // it stands now, so no worker will run it; a launch reserved for it fails
  // the session with CATALOG_MISMATCH. Judged on every read: restoring the
  // pair clears it, and the next message runs again (94S-280).
  z.object({
    code: z.literal("CATALOG_MISMATCH"),
    reason: z.string().min(1),
  }),
]);
export const sessionDurabilitySchema = z.object({
  last_transcript_persisted_at: timestampSchema.nullable(),
  checkpoint_committed_at: timestampSchema.nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  last_completed_turn_id: turnIdSchema.nullable(),
  last_checkpointed_turn_id: turnIdSchema.nullable(),
  checkpoint_pending_reason: z.string().min(1).nullable(),
  // The earlier revision the session was last restored from because the
  // checkpoint at checkpoint_revision was damaged (94S-204). While set, the
  // session holds that revision's state and has lost what the newer ones
  // recorded; the next committed checkpoint clears it.
  checkpoint_fallback_revision: revisionSchema.nullable(),
  // The last turn whose context a start_fresh decision gave up: the engine
  // session running now began after it and does not remember it or anything
  // before. Null while the session has never been reset.
  context_reset_turn_id: turnIdSchema.nullable(),
});

// DESIGN.md §6.4.
const NEEDS_INPUT_PROJECTION =
  "needs_input is derived when read: a running session or turn with at least one pending request a client can still answer (open, unexpired, raised by the attempt that holds the turn). It returns to running as soon as none is left, whether by an answer, the worker settling the request, expiry or the attempt losing the session, with no change to updated_at and no status event.";

export const sessionSummarySchema = z.object({
  id: sessionIdSchema,
  revision: revisionSchema,
  admission_state: admissionStateSchema,
  status: sessionStatusSchema.meta({ description: NEEDS_INPUT_PROJECTION }),
  runtime: sessionRuntimeSchema,
  // Catalog key only. Sessions created before the catalog existed (M0
  // legacy rows) carry no key and surface null; the stored repo URL is
  // never exposed because it may embed credentials (94S-147).
  repository_id: z.string().min(1).nullable(),
  current_turn_id: turnIdSchema.nullable(),
  queued_turn_count: z.number().int().nonnegative(),
  last_event_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export const sessionDetailSchema = sessionSummarySchema.extend({
  execution: executionObservationSchema.nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  pending_request_count: z.number().int().nonnegative().meta({
    description:
      "The requests GET /v1/sessions/{id}/pending-requests lists, counted in the same read as status: status reads needs_input exactly when this is above zero and the session would otherwise read running.",
  }),
  attention: sessionAttentionSchema.nullable(),
  durability: sessionDurabilitySchema,
});

export const MESSAGE_MAX_BYTES = 32 * 1024;
export const PAYLOAD_TOO_LARGE_ISSUE = "PAYLOAD_TOO_LARGE";
export const REQUEST_BODY_MAX_BYTES = 64 * 1024;
const utf8 = new TextEncoder();
export const messageTextSchema = z
  .string()
  .min(1)
  .refine((text) => utf8.encode(text).length <= MESSAGE_MAX_BYTES, {
    message: `Message exceeds ${MESSAGE_MAX_BYTES} UTF-8 bytes`,
    // Lets HTTP handlers answer 413 instead of the generic 400.
    params: { code: PAYLOAD_TOO_LARGE_ISSUE },
  })
  .meta({ description: `At most ${MESSAGE_MAX_BYTES} bytes of UTF-8` });

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
  status: sessionStatusSchema.optional().meta({
    description:
      "Filters on the status each item reports, needs_input included as derived when read.",
  }),
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
export type PauseBlockedReason = z.infer<typeof pauseBlockedReasonSchema>;
export type SessionDurability = z.infer<typeof sessionDurabilitySchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;
