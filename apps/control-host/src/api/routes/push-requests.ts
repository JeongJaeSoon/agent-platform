import {
  createPushRequestRequestSchema,
  type DecidePushRequestRequest,
  decidePushRequestRequestSchema,
  listPushRequestsResponseSchema,
  type PushDecision,
  pushRequestParamsSchema,
  pushRequestSchema,
  resolvePushRequestRequestSchema,
  sessionIdParamsSchema,
} from "@werft-ai/contracts";
import type { PushActor, PushRequestService } from "@werft-ai/platform";
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
    const body = await parseJsonBody(context, createPushRequestRequestSchema);
    const created = await mapped(() =>
      service.create(actorOf(context), params.id, {
        idempotencyKey: key,
        body,
      }),
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

  // `/approve`, `/reject` and the old `/decision` share one idempotency
  // scope and hash the same body, so a key replays across them.
  const resolve =
    (
      readBody: (
        context: Context<ApiEnvironment>,
      ) => Promise<DecidePushRequestRequest>,
    ) =>
    async (context: Context<ApiEnvironment>) => {
      const params = requireParams(context, pushRequestParamsSchema);
      const key = requireIdempotencyKey(context);
      const resolved = await mapped(() =>
        service.decide(actorOf(context), params.id, params.push_request_id, {
          idempotencyKey: key,
          readBody: () => readBody(context),
        }),
      );
      return jsonWithSchema(context, pushRequestSchema, resolved);
    };
  const withAction = (decision: PushDecision) =>
    resolve(async (context) => ({
      decision,
      ...(await parseJsonBody(context, resolvePushRequestRequestSchema)),
    }));

  apiRoute(router, "approvePushRequest", withAction("approve"));
  apiRoute(router, "rejectPushRequest", withAction("reject"));
  apiRoute(
    router,
    "decidePushRequest",
    async (context, next) => {
      context.header("Deprecation", "true");
      await next();
    },
    resolve((context) =>
      parseJsonBody(context, decidePushRequestRequestSchema),
    ),
  );
}
