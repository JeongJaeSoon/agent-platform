import {
  controlAcceptedResponseSchema,
  interruptSessionRequestSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import type { InterruptService } from "@agent-platform/platform";
import { type ApiRouter, jsonWithSchema, parseJsonBody } from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./errors.ts";

export function registerInterruptRoutes(
  router: ApiRouter,
  service: InterruptService,
) {
  router.post("/sessions/:id/interrupt", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, interruptSessionRequestSchema);
    const accepted = await mapped(() =>
      service.interrupt({ ownerId: context.get("ownerId") }, params.id, {
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
