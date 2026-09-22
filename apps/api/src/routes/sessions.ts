import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  idempotencyKeySchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  sessionIdParamsSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
} from "@agent-platform/contracts";
import { InvalidCursorError } from "@agent-platform/db";
import {
  type SessionService,
  SessionServiceError,
} from "@agent-platform/platform";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import {
  type ApiEnvironment,
  ApiHttpError,
  type ApiRouter,
  isStorageUnavailable,
  jsonWithSchema,
  parseJsonBody,
  storageUnavailableError,
} from "../app.ts";

const STATUS_BY_CODE: Partial<
  Record<SessionServiceError["code"], ContentfulStatusCode>
> = {
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  UNSUPPORTED_CAPABILITY: 422,
  NOT_FOUND: 404,
  SESSION_PAUSED: 409,
  SESSION_RESUMING: 409,
  SESSION_STOPPED: 409,
  SESSION_CLOSED: 409,
  RECOVERY_REQUIRED: 409,
};

// pg connection/admin-shutdown errors (SQLSTATE 08xxx, 57Pxx) and socket
// failures; drizzle wraps them, so look at the cause too.
export async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SessionServiceError) {
      throw new ApiHttpError(
        STATUS_BY_CODE[error.code] ?? 500,
        error.code,
        error.message,
      );
    }
    if (error instanceof InvalidCursorError) {
      throw new ApiHttpError(400, "BAD_REQUEST", "Invalid cursor");
    }
    if (isStorageUnavailable(error)) {
      throw storageUnavailableError();
    }
    throw error;
  }
}

// Error statuses each handler can produce; the OpenAPI parity test holds the
// route table to this. 429 stays declared-only until quota lands (94S-131).
export const sessionRouteErrors: Record<string, number[]> = {
  "POST /v1/sessions": [400, 401, 409, 413, 422, 503],
  "GET /v1/sessions": [400, 401, 503],
  "GET /v1/sessions/{id}": [401, 404, 503],
  "POST /v1/sessions/{id}/messages": [400, 401, 404, 409, 413, 503],
  "GET /v1/sessions/{id}/turns": [400, 401, 404, 503],
  "GET /v1/sessions/{id}/turns/{turn_id}": [401, 404, 503],
  "POST /v1/sessions/{id}/terminate": [400, 401, 404, 409, 413, 422, 503],
};

function requireIdempotencyKey(context: Context<ApiEnvironment>): string {
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

function requireQuery<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): z.infer<T> {
  const query = schema.safeParse(context.req.query());
  if (!query.success) {
    throw new ApiHttpError(400, "BAD_REQUEST", "Query parameters are invalid");
  }
  return query.data;
}

export function registerSessionRoutes(
  router: ApiRouter,
  service: SessionService,
) {
  router.post("/sessions", async (context) => {
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, createSessionRequestSchema);
    const created = await mapped(() =>
      service.createSession(
        { ownerId: context.get("ownerId") },
        { idempotencyKey: key, body },
      ),
    );
    return jsonWithSchema(context, createSessionResponseSchema, created, 201);
  });

  router.get("/sessions", async (context) => {
    const query = requireQuery(context, listSessionsQuerySchema);
    const page = await mapped(() =>
      service.listSessions({ ownerId: context.get("ownerId") }, query),
    );
    return jsonWithSchema(context, listSessionsResponseSchema, page);
  });

  router.get("/sessions/:id", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const detail = await mapped(() =>
      service.getSession({ ownerId: context.get("ownerId") }, params.id),
    );
    return jsonWithSchema(context, getSessionResponseSchema, detail);
  });

  router.post("/sessions/:id/messages", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, postSessionMessageRequestSchema);
    const accepted = await mapped(() =>
      service.appendMessage({ ownerId: context.get("ownerId") }, params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(
      context,
      postSessionMessageResponseSchema,
      accepted,
      202,
    );
  });

  router.post("/sessions/:id/terminate", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, terminateSessionRequestSchema);
    const accepted = await mapped(() =>
      service.terminateSession({ ownerId: context.get("ownerId") }, params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(
      context,
      terminateSessionResponseSchema,
      accepted,
      202,
    );
  });

  router.get("/sessions/:id/turns", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const query = requireQuery(context, listTurnsQuerySchema);
    const page = await mapped(() =>
      service.listTurns({ ownerId: context.get("ownerId") }, params.id, query),
    );
    return jsonWithSchema(context, listTurnsResponseSchema, page);
  });

  router.get("/sessions/:id/turns/:turn_id", async (context) => {
    const params = requireParams(context, turnIdParamsSchema);
    const turn = await mapped(() =>
      service.getTurn(
        { ownerId: context.get("ownerId") },
        params.id,
        params.turn_id,
      ),
    );
    return jsonWithSchema(context, getTurnResponseSchema, turn);
  });
}
