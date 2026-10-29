import {
  deleteGitHubAppResponseSchema,
  getGitHubAppResponseSchema,
  putGitHubAppRequestSchema,
  putGitHubAppResponseSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { GitHubAppService } from "@werft-ai/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

function lowercaseWorkspaceId(context: Context<ApiEnvironment>): string {
  return requireParams(context, workspaceParamsSchema).id.toLowerCase();
}

export function registerGitHubAppRoutes(
  router: ApiRouter,
  service: GitHubAppService,
) {
  apiRoute(router, "getGitHubApp", async (context) => {
    const app = await mapped(() =>
      service.describe(context.get("caller"), lowercaseWorkspaceId(context)),
    );
    return jsonWithSchema(context, getGitHubAppResponseSchema, app);
  });

  apiRoute(router, "putGitHubApp", async (context) => {
    const set = await mapped(() =>
      service.register(
        context.get("caller"),
        lowercaseWorkspaceId(context),
        () => parseJsonBody(context, putGitHubAppRequestSchema),
      ),
    );
    return jsonWithSchema(context, putGitHubAppResponseSchema, set);
  });

  apiRoute(router, "deleteGitHubApp", async (context) => {
    const deleted = await mapped(() =>
      service.remove(context.get("caller"), lowercaseWorkspaceId(context)),
    );
    return jsonWithSchema(context, deleteGitHubAppResponseSchema, deleted);
  });
}
