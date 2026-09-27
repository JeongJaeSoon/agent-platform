import {
  controlAcceptedResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  recoveryDecisionRequestSchema,
  resumeSessionRequestSchema,
  sessionIdParamsSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
} from "@agent-platform/contracts";
import type { SessionService } from "@agent-platform/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import {
  mapped,
  requireIdempotencyKey,
  requireParams,
  requireQuery,
} from "./errors.ts";

export function registerSessionRoutes(
  router: ApiRouter,
  service: SessionService,
) {
  apiRoute(router, "createSession", async (context) => {
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

  apiRoute(router, "listSessions", async (context) => {
    const query = requireQuery(context, listSessionsQuerySchema);
    const page = await mapped(() =>
      service.listSessions({ ownerId: context.get("ownerId") }, query),
    );
    return jsonWithSchema(context, listSessionsResponseSchema, page);
  });

  apiRoute(router, "getSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const detail = await mapped(() =>
      service.getSession({ ownerId: context.get("ownerId") }, params.id),
    );
    return jsonWithSchema(context, getSessionResponseSchema, detail);
  });

  apiRoute(router, "appendSessionMessage", async (context) => {
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

  apiRoute(router, "terminateSession", async (context) => {
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

  apiRoute(router, "resumeSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, resumeSessionRequestSchema);
    const accepted = await mapped(() =>
      service.resumeSession({ ownerId: context.get("ownerId") }, params.id, {
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

  apiRoute(router, "decideSessionRecovery", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, recoveryDecisionRequestSchema);
    const accepted = await mapped(() =>
      service.decideRecovery({ ownerId: context.get("ownerId") }, params.id, {
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

  apiRoute(router, "listSessionTurns", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const query = requireQuery(context, listTurnsQuerySchema);
    const page = await mapped(() =>
      service.listTurns({ ownerId: context.get("ownerId") }, params.id, query),
    );
    return jsonWithSchema(context, listTurnsResponseSchema, page);
  });

  apiRoute(router, "getSessionTurn", async (context) => {
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
