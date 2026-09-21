import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  idempotencyKeySchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import { InvalidCursorError } from "@agent-platform/db";
import {
  type SessionService,
  SessionServiceError,
} from "@agent-platform/platform";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ApiHttpError,
  type ApiRouter,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";

const STATUS_BY_CODE: Partial<
  Record<SessionServiceError["code"], ContentfulStatusCode>
> = {
  IDEMPOTENCY_CONFLICT: 409,
  UNSUPPORTED_CAPABILITY: 422,
  NOT_FOUND: 404,
};

// pg connection/admin-shutdown errors (SQLSTATE 08xxx, 57Pxx) and socket
// failures; drizzle wraps them, so look at the cause too.
function isStorageUnavailable(error: unknown): boolean {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code = (cause as { code?: unknown })?.code;
  return (
    typeof code === "string" &&
    (code.startsWith("08") ||
      code.startsWith("57P") ||
      code.startsWith("ECONN"))
  );
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
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
      throw new ApiHttpError(
        503,
        "BACKEND_UNAVAILABLE",
        "Storage is unavailable, retry with the same Idempotency-Key",
        true,
      );
    }
    throw error;
  }
}

export function registerSessionRoutes(
  router: ApiRouter,
  service: SessionService,
) {
  router.post("/sessions", async (context) => {
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
    const body = await parseJsonBody(context, createSessionRequestSchema);
    const created = await mapped(() =>
      service.createSession(
        { ownerId: context.get("ownerId") },
        { idempotencyKey: key.data, body },
      ),
    );
    return jsonWithSchema(context, createSessionResponseSchema, created, 201);
  });

  router.get("/sessions", async (context) => {
    const query = listSessionsQuerySchema.safeParse(context.req.query());
    if (!query.success) {
      throw new ApiHttpError(
        400,
        "BAD_REQUEST",
        "Query parameters are invalid",
      );
    }
    const page = await mapped(() =>
      service.listSessions({ ownerId: context.get("ownerId") }, query.data),
    );
    return jsonWithSchema(context, listSessionsResponseSchema, page);
  });

  router.get("/sessions/:id", async (context) => {
    // A malformed id is indistinguishable from a missing session on purpose.
    const params = sessionIdParamsSchema.safeParse(context.req.param());
    if (!params.success) {
      throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
    }
    const detail = await mapped(() =>
      service.getSession({ ownerId: context.get("ownerId") }, params.data.id),
    );
    return jsonWithSchema(context, getSessionResponseSchema, detail);
  });
}
