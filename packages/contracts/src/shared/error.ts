import { z } from "zod";

export const API_ERROR_CODE_VALUES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_CAPABILITY",
  "RATE_LIMITED",
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
  "BACKEND_UNAVAILABLE",
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
