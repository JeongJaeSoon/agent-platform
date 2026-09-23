import { z } from "zod";

export const API_ERROR_CODE_VALUES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BOOTSTRAP_DONE",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "REQUEST_TIMEOUT",
  "UNSUPPORTED_CAPABILITY",
  "RATE_LIMITED",
  // The installation's retained-content budget is spent; retrying does not
  // free any of it (94S-131).
  "STORAGE_LIMIT_EXCEEDED",
  // A turn the engine ended because the session's cost budget ran out while
  // it was running (94S-279).
  "BUDGET_EXCEEDED",
  "INTERNAL_ERROR",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_EXPIRED",
  "REQUEST_STALE",
  "SESSION_PAUSED",
  "SESSION_RESUMING",
  "SESSION_CLOSED",
  "SESSION_STOPPED",
  "RECOVERY_REQUIRED",
  "CHECKPOINT_UNAVAILABLE",
  "PAUSE_COMMITTING",
  "PAUSE_CANCELLED",
  "CONTROL_SUPERSEDED",
  "TURN_NOT_STARTED",
  "BACKEND_UNAVAILABLE",
  "LAUNCH_FAILED",
  // The catalog no longer allows the session's (profile, repository) pair,
  // so no worker may run it until an operator restores the pair (94S-280).
  "CATALOG_MISMATCH",
  "NOT_READY",
  "CURSOR_EXPIRED",
  "LEASE_EXPIRED",
  "STALE_EPOCH",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODE_VALUES);
export const apiErrorSchema = z
  .object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    request_id: z.string().min(1),
    details: z.unknown().nullable(),
  })
  .strict();
export const apiErrorResponseSchema = z
  .object({ error: apiErrorSchema })
  .strict();

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
