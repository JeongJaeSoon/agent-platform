import {
  adminTerminateSessionRequestSchema,
  auditReadRequestSchema,
  auditReadResponseSchema,
  listAdminSessionsResponseSchema,
  sessionIdParamsSchema,
  sessionShareSchema,
  setSessionShareRequestSchema,
  setSessionShareResponseSchema,
  terminateSessionResponseSchema,
} from "@agent-platform/contracts";
import type {
  SessionService,
  SessionShareService,
} from "@agent-platform/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireIdempotencyKey, requireParams } from "./errors.ts";

export function registerSessionShareRoutes(
  router: ApiRouter,
  shares: SessionShareService,
  sessions: Pick<SessionService, "auditRead" | "terminateSession">,
) {
  apiRoute(router, "getSessionShare", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const share = await mapped(() =>
      shares.getShare(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, sessionShareSchema, share);
  });

  apiRoute(router, "setSessionShare", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const body = await parseJsonBody(context, setSessionShareRequestSchema);
    const change = await mapped(() =>
      shares.setShare(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, setSessionShareResponseSchema, change);
  });

  apiRoute(router, "auditReadSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const body = await parseJsonBody(context, auditReadRequestSchema);
    const read = await mapped(() =>
      sessions.auditRead(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, auditReadResponseSchema, read);
  });

  apiRoute(router, "listAdminSessions", async (context) => {
    const page = await mapped(() => shares.listForAdmin(context.get("caller")));
    return jsonWithSchema(context, listAdminSessionsResponseSchema, page);
  });

  apiRoute(router, "adminTerminateSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(
      context,
      adminTerminateSessionRequestSchema,
    );
    const accepted = await mapped(() =>
      sessions.terminateSession(context.get("caller"), params.id, {
        idempotencyKey: key,
        body: { expected_revision: body.expected_revision },
        justification: body.justification,
      }),
    );
    return jsonWithSchema(
      context,
      terminateSessionResponseSchema,
      accepted,
      202,
    );
  });
}
