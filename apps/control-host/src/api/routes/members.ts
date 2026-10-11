import {
  listMembersResponseSchema,
  listTakeoversResponseSchema,
  memberUserParamsSchema,
  sessionIdParamsSchema,
  takeOverSessionResponseSchema,
  updateMemberRequestSchema,
  updateMemberResponseSchema,
} from "@agent-platform/contracts";
import type { InviteService, MemberService } from "@agent-platform/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerMemberRoutes(
  router: ApiRouter,
  service: Pick<MemberService, "listTakeovers" | "takeOverSession">,
  roles: Pick<InviteService, "listMembers" | "changeMemberRole">,
) {
  apiRoute(router, "listMembers", async (context) => {
    const items = await mapped(() => roles.listMembers(context.get("caller")));
    return jsonWithSchema(context, listMembersResponseSchema, { items });
  });

  apiRoute(router, "updateMember", async (context) => {
    const params = requireParams(context, memberUserParamsSchema);
    const body = await parseJsonBody(context, updateMemberRequestSchema);
    const member = await mapped(() =>
      roles.changeMemberRole(context.get("caller"), params.user_id, body.role),
    );
    return jsonWithSchema(context, updateMemberResponseSchema, member);
  });

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
