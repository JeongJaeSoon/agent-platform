import {
  type ApiErrorCode,
  idempotencyKeySchema,
} from "@agent-platform/contracts";
import {
  InvalidCursorError,
  SessionServiceError,
} from "@agent-platform/platform";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { type ApiEnvironment, ApiHttpError } from "../app.ts";

// The one table from a service error code to its HTTP status on the /v1
// routes. A code missing here answers 500.
const STATUS_BY_CODE: Partial<Record<ApiErrorCode, ContentfulStatusCode>> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  REQUEST_STALE: 409,
  REQUEST_EXPIRED: 409,
  CHECKPOINT_UNAVAILABLE: 409,
  SESSION_PAUSED: 409,
  SESSION_RESUMING: 409,
  PAUSE_COMMITTING: 409,
  SESSION_STOPPED: 409,
  SESSION_CLOSED: 409,
  RECOVERY_REQUIRED: 409,
  TURN_NOT_STARTED: 409,
  STORAGE_LIMIT_EXCEEDED: 413,
  UNSUPPORTED_CAPABILITY: 422,
  RATE_LIMITED: 429,
  BACKEND_UNAVAILABLE: 503,
};

// Storage outages need nothing here: the app's error hook answers them.
export async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SessionServiceError) {
      throw new ApiHttpError(
        STATUS_BY_CODE[error.code] ?? 500,
        error.code,
        error.message,
        error.retry !== undefined,
        error.retry?.afterSeconds,
      );
    }
    if (error instanceof InvalidCursorError) {
      throw new ApiHttpError(400, "BAD_REQUEST", "Invalid cursor");
    }
    throw error;
  }
}

export function requireIdempotencyKey(
  context: Context<ApiEnvironment>,
): string {
  const key = idempotencyKeySchema.safeParse(
    context.req.header("Idempotency-Key"),
  );
  if (!key.success) {
    throw new ApiHttpError(
      400,
      "BAD_REQUEST",
      "Idempotency-Key header is required",
    );
  }
  return key.data;
}

// A malformed id is indistinguishable from a missing session on purpose.
export function requireParams<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): z.infer<T> {
  const params = schema.safeParse(context.req.param());
  if (!params.success) {
    throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
  }
  return params.data;
}

export function requireQuery<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): z.infer<T> {
  const query = schema.safeParse(context.req.query());
  if (!query.success) {
    throw new ApiHttpError(400, "BAD_REQUEST", "Query parameters are invalid");
  }
  return query.data;
}
