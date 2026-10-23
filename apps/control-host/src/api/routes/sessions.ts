import {
  changeSessionProfileRequestSchema,
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
  updateSessionRequestSchema,
} from "@werft-ai/contracts";
import type { SessionService } from "@werft-ai/platform";
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
      service.createSession(context.get("caller"), {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(context, createSessionResponseSchema, created, 201);
  });

  apiRoute(router, "listSessions", async (context) => {
    const query = requireQuery(context, listSessionsQuerySchema);
    const page = await mapped(() =>
      service.listSessions(context.get("caller"), query),
    );
    return jsonWithSchema(context, listSessionsResponseSchema, page);
  });

  apiRoute(router, "getSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const detail = await mapped(() =>
      service.getSession(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSessionResponseSchema, detail);
  });

  apiRoute(router, "updateSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const body = await parseJsonBody(context, updateSessionRequestSchema);
    const detail = await mapped(() =>
      service.renameSession(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, getSessionResponseSchema, detail);
  });

  apiRoute(router, "appendSessionMessage", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, postSessionMessageRequestSchema);
    const accepted = await mapped(() =>
      service.appendMessage(context.get("caller"), params.id, {
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
      service.terminateSession(context.get("caller"), params.id, {
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
      service.resumeSession(context.get("caller"), params.id, {
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

  apiRoute(router, "changeSessionProfile", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(
      context,
      changeSessionProfileRequestSchema,
    );
    const settled = await mapped(() =>
      service.changeSessionProfile(context.get("caller"), params.id, {
        idempotencyKey: key,
        body,
      }),
    );
    return jsonWithSchema(context, controlAcceptedResponseSchema, settled, 200);
  });

  apiRoute(router, "decideSessionRecovery", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, recoveryDecisionRequestSchema);
    const accepted = await mapped(() =>
      service.decideRecovery(context.get("caller"), params.id, {
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
      service.listTurns(context.get("caller"), params.id, query),
    );
    return jsonWithSchema(context, listTurnsResponseSchema, page);
  });

  apiRoute(router, "getSessionTurn", async (context) => {
    const params = requireParams(context, turnIdParamsSchema);
    const turn = await mapped(() =>
      service.getTurn(context.get("caller"), params.id, params.turn_id),
    );
    return jsonWithSchema(context, getTurnResponseSchema, turn);
  });
}
