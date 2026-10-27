import {
  createWorkspaceProfileRequestSchema,
  listProfilesResponseSchema,
  workspaceProfileChangeResponseSchema,
  workspaceProfileIdParamsSchema,
} from "@werft-ai/contracts";
import type { WorkspaceProfileService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerProfileRoutes(
  router: ApiRouter,
  profiles: WorkspaceProfileService,
) {
  apiRoute(router, "listProfiles", async (context) => {
    const listed = await mapped(() => profiles.list(context.get("caller")));
    return jsonWithSchema(context, listProfilesResponseSchema, listed);
  });

  apiRoute(router, "createWorkspaceProfile", async (context) => {
    const body = await parseJsonBody(
      context,
      createWorkspaceProfileRequestSchema,
    );
    const created = await mapped(() =>
      profiles.create(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      workspaceProfileChangeResponseSchema,
      created,
      201,
    );
  });

  apiRoute(router, "retireWorkspaceProfile", async (context) => {
    const params = requireParams(context, workspaceProfileIdParamsSchema);
    const retired = await mapped(() =>
      profiles.retire(context.get("caller"), params.profile_id),
    );
    return jsonWithSchema(
      context,
      workspaceProfileChangeResponseSchema,
      retired,
    );
  });
}
