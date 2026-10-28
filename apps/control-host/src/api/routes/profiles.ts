import {
  createInstallationProfileRequestSchema,
  createWorkspaceProfileRequestSchema,
  installationProfileChangeResponseSchema,
  installationProfileIdParamsSchema,
  installationProfileOptionsResponseSchema,
  listProfilesResponseSchema,
  workspaceProfileChangeResponseSchema,
  workspaceProfileIdParamsSchema,
} from "@werft-ai/contracts";
import type {
  InstallationProfileService,
  WorkspaceProfileService,
} from "@werft-ai/platform";
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
  installation: InstallationProfileService,
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

  apiRoute(router, "getInstallationProfileOptions", async (context) => {
    const options = await mapped(() =>
      installation.options(context.get("caller")),
    );
    return jsonWithSchema(
      context,
      installationProfileOptionsResponseSchema,
      options,
    );
  });

  apiRoute(router, "createInstallationProfile", async (context) => {
    const body = await parseJsonBody(
      context,
      createInstallationProfileRequestSchema,
    );
    const created = await mapped(() =>
      installation.create(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      installationProfileChangeResponseSchema,
      created,
      201,
    );
  });

  apiRoute(router, "retireInstallationProfile", async (context) => {
    const params = requireParams(context, installationProfileIdParamsSchema);
    const retired = await mapped(() =>
      installation.retire(context.get("caller"), params.profile_id),
    );
    return jsonWithSchema(
      context,
      installationProfileChangeResponseSchema,
      retired,
    );
  });

  for (const [operationId, blocked] of [
    ["blockInstallationProfile", true],
    ["unblockInstallationProfile", false],
  ] as const) {
    apiRoute(router, operationId, async (context) => {
      const params = requireParams(context, installationProfileIdParamsSchema);
      const changed = await mapped(() =>
        installation.setBlocked(
          context.get("caller"),
          params.profile_id,
          blocked,
        ),
      );
      return jsonWithSchema(
        context,
        installationProfileChangeResponseSchema,
        changed,
      );
    });
  }
}
