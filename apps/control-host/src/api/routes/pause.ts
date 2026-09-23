import {
  controlAcceptedResponseSchema,
  pauseSessionRequestSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import type { SessionService } from "@agent-platform/platform";
import { type ApiRouter, jsonWithSchema, parseJsonBody } from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./sessions.ts";

// Error statuses the handler can produce; the OpenAPI parity test holds the
// route table to this.
export const pauseRouteErrors: Record<string, number[]> = {
  "POST /v1/sessions/{id}/pause": [400, 401, 404, 409, 413, 422, 503],
};

export function registerPauseRoutes(
  router: ApiRouter,
  service: Pick<SessionService, "pauseSession">,
) {
  router.post("/sessions/:id/pause", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, pauseSessionRequestSchema);
    const accepted = await mapped(() =>
      service.pauseSession({ ownerId: context.get("ownerId") }, params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(
      context,
      controlAcceptedResponseSchema,
      accepted,
      202,
    );
  });
}
