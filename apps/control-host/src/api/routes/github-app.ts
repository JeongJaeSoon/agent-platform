import {
  deleteGitHubAppResponseSchema,
  type GitHubAppRole,
  getGitHubAppResponseSchema,
  githubAppRoleParamsSchema,
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

// `/github-app` is the author App's, kept as it was; `/github-apps/{role}`
// names the role.
function target(context: Context<ApiEnvironment>): {
  workspaceId: string;
  role: GitHubAppRole;
} {
  if (context.req.param("role") === undefined) {
    const { id } = requireParams(context, workspaceParamsSchema);
    return { workspaceId: id.toLowerCase(), role: "author" };
  }
  const { id, role } = requireParams(context, githubAppRoleParamsSchema);
  return { workspaceId: id.toLowerCase(), role };
}

export function registerGitHubAppRoutes(
  router: ApiRouter,
  service: GitHubAppService,
) {
  for (const [get, put, remove] of [
    ["getGitHubApp", "putGitHubApp", "deleteGitHubApp"],
    [
      "getWorkspaceGitHubApp",
      "putWorkspaceGitHubApp",
      "deleteWorkspaceGitHubApp",
    ],
  ] as const) {
    apiRoute(router, get, async (context) => {
      const { workspaceId, role } = target(context);
      const app = await mapped(() =>
        service.describe(context.get("caller"), workspaceId, role),
      );
      return jsonWithSchema(context, getGitHubAppResponseSchema, app);
    });

    apiRoute(router, put, async (context) => {
      const { workspaceId, role } = target(context);
      const set = await mapped(() =>
        service.register(context.get("caller"), workspaceId, role, () =>
          parseJsonBody(context, putGitHubAppRequestSchema),
        ),
      );
      return jsonWithSchema(context, putGitHubAppResponseSchema, set);
    });

    apiRoute(router, remove, async (context) => {
      const { workspaceId, role } = target(context);
      const deleted = await mapped(() =>
        service.remove(context.get("caller"), workspaceId, role),
      );
      return jsonWithSchema(context, deleteGitHubAppResponseSchema, deleted);
    });
  }
}
