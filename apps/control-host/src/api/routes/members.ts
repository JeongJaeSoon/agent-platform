import {
  listTakeoversResponseSchema,
  sessionIdParamsSchema,
  takeOverSessionResponseSchema,
} from "@agent-platform/contracts";
import type { MemberService } from "@agent-platform/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerMemberRoutes(
  router: ApiRouter,
  service: Pick<MemberService, "listTakeovers" | "takeOverSession">,
) {
  apiRoute(router, "listTakeovers", async (context) => {
    const page = await mapped(() =>
      service.listTakeovers(context.get("caller")),
    );
    return jsonWithSchema(context, listTakeoversResponseSchema, page);
  });

  apiRoute(router, "takeOverSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const receipt = await mapped(() =>
      service.takeOverSession(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, takeOverSessionResponseSchema, receipt);
  });
}
