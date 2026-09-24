import {
  controlAcceptedResponseSchema,
  interruptSessionRequestSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import {
  type InterruptService,
  SessionServiceError,
} from "@agent-platform/platform";
import {
  ApiHttpError,
  type ApiRouter,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./sessions.ts";

// Error statuses the handler can produce; the OpenAPI parity test holds the
// route table to this.
export const interruptRouteErrors: Record<string, number[]> = {
  "POST /v1/sessions/{id}/interrupt": [400, 401, 404, 409, 413, 422, 503],
};

export function registerInterruptRoutes(
  router: ApiRouter,
  service: InterruptService,
) {
  router.post("/sessions/:id/interrupt", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, interruptSessionRequestSchema);
    const accepted = await mapped(async () => {
      try {
        return await service.interrupt(
          { ownerId: context.get("ownerId") },
          params.id,
          { idempotencyKey: key, body },
        );
      } catch (error) {
        // The only code this route adds to what every session route maps.
        if (
          error instanceof SessionServiceError &&
          error.code === "TURN_NOT_STARTED"
        ) {
          throw new ApiHttpError(409, error.code, error.message);
        }
        throw error;
      }
    });
    return jsonWithSchema(
      context,
      controlAcceptedResponseSchema,
      accepted,
      202,
    );
  });
}
