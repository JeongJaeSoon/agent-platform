import {
  type ApiErrorCode,
  listPendingRequestsResponseSchema,
  postSessionAnswerRequestSchema,
  postSessionAnswerResponseSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import {
  type PendingRequestService,
  SessionServiceError,
} from "@agent-platform/platform";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ApiHttpError,
  type ApiRouter,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./sessions.ts";

// Error statuses each handler can produce; the OpenAPI parity test holds the
// route table to this.
export const pendingRouteErrors: Record<string, number[]> = {
  "GET /v1/sessions/{id}/pending-requests": [401, 404, 503],
  "POST /v1/sessions/{id}/answers": [400, 401, 404, 409, 413, 503],
};

// Codes only the answer path produces; the rest map as every session route.
const STATUS_BY_CODE: Partial<Record<ApiErrorCode, ContentfulStatusCode>> = {
  BAD_REQUEST: 400,
  REQUEST_EXPIRED: 409,
  REQUEST_STALE: 409,
};

async function answerMapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const status =
      error instanceof SessionServiceError
        ? STATUS_BY_CODE[error.code]
        : undefined;
    if (error instanceof SessionServiceError && status !== undefined) {
      throw new ApiHttpError(status, error.code, error.message);
    }
    throw error;
  }
}

export function registerPendingRoutes(
  router: ApiRouter,
  service: PendingRequestService,
) {
  router.get("/sessions/:id/pending-requests", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const page = await mapped(() =>
      service.listPendingRequests(
        { ownerId: context.get("ownerId") },
        params.id,
      ),
    );
    return jsonWithSchema(context, listPendingRequestsResponseSchema, page);
  });

  router.post("/sessions/:id/answers", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, postSessionAnswerRequestSchema);
    const accepted = await mapped(() =>
      answerMapped(() =>
        service.answer({ ownerId: context.get("ownerId") }, params.id, {
          idempotencyKey: key,
          body,
        }),
      ),
    );
    return jsonWithSchema(
      context,
      postSessionAnswerResponseSchema,
      accepted,
      202,
    );
  });
}
