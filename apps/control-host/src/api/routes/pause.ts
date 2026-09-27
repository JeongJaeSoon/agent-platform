import {
  controlAcceptedResponseSchema,
  pauseSessionRequestSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import type { SessionService } from "@agent-platform/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./errors.ts";

export function registerPauseRoutes(
  router: ApiRouter,
  service: Pick<SessionService, "pauseSession">,
) {
  apiRoute(router, "pauseSession", async (context) => {
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
