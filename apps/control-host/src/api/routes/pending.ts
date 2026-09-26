import {
  listPendingRequestsResponseSchema,
  postSessionAnswerRequestSchema,
  postSessionAnswerResponseSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import type { PendingRequestService } from "@agent-platform/platform";
import { type ApiRouter, jsonWithSchema, parseJsonBody } from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./errors.ts";

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
      service.answer({ ownerId: context.get("ownerId") }, params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(
      context,
      postSessionAnswerResponseSchema,
      accepted,
      202,
    );
  });
}
