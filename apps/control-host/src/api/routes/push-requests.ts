import {
  createPushRequestRequestSchema,
  decidePushRequestRequestSchema,
  listPushRequestsResponseSchema,
  pushRequestParamsSchema,
  pushRequestSchema,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import type { PushActor, PushRequestService } from "@agent-platform/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./errors.ts";

export function actorOf(context: Context<ApiEnvironment>): PushActor {
  return {
    caller: context.get("caller"),
    principal: context.get("principal"),
    ownerId: context.get("ownerId"),
    verified: context.get("verified"),
  };
}

export function registerPushRequestRoutes(
  router: ApiRouter,
  service: PushRequestService,
) {
  apiRoute(router, "createPushRequest", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    await parseJsonBody(context, createPushRequestRequestSchema);
    const created = await mapped(() =>
      service.create(actorOf(context), params.id, { idempotencyKey: key }),
    );
    return jsonWithSchema(context, pushRequestSchema, created, 201);
  });

  apiRoute(router, "listPushRequests", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const page = await mapped(() => service.list(actorOf(context), params.id));
    return jsonWithSchema(context, listPushRequestsResponseSchema, page);
  });

  apiRoute(router, "getPushRequest", async (context) => {
    const params = requireParams(context, pushRequestParamsSchema);
    const request = await mapped(() =>
      service.get(actorOf(context), params.id, params.push_request_id),
    );
    return jsonWithSchema(context, pushRequestSchema, request);
  });

  apiRoute(router, "decidePushRequest", async (context) => {
    const params = requireParams(context, pushRequestParamsSchema);
    const key = requireIdempotencyKey(context);
    const decided = await mapped(() =>
      service.decide(actorOf(context), params.id, params.push_request_id, {
        idempotencyKey: key,
        readBody: () => parseJsonBody(context, decidePushRequestRequestSchema),
      }),
    );
    return jsonWithSchema(context, pushRequestSchema, decided);
  });
}
