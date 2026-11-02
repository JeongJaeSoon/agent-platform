import {
  agentIdParamsSchema,
  githubRepositoryPageQuerySchema,
  githubRepositoryParamsSchema,
  githubRepositoryWriteResponseSchema,
  listAgentGitHubRepositoriesResponseSchema,
  listGitHubRepositoriesResponseSchema,
  patchGitHubRepositoryRequestSchema,
  pickAgentGitHubRepositoryRequestSchema,
  pickAgentGitHubRepositoryResponseSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { GitHubRepositoryService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams, requireQuery } from "./errors.ts";

export function registerGitHubRepositoryRoutes(
  router: ApiRouter,
  service: GitHubRepositoryService,
) {
  apiRoute(router, "listGitHubRepositories", async (context) => {
    const { id } = requireParams(context, workspaceParamsSchema);
    const query = requireQuery(context, githubRepositoryPageQuerySchema);
    const listed = await mapped(() =>
      service.list(context.get("caller"), id.toLowerCase(), query),
    );
    return jsonWithSchema(
      context,
      listGitHubRepositoriesResponseSchema,
      listed,
    );
  });

  apiRoute(router, "updateGitHubRepository", async (context) => {
    const { id, repositoryId } = requireParams(
      context,
      githubRepositoryParamsSchema,
    );
    const set = await mapped(() =>
      service.setBranch(
        context.get("caller"),
        id.toLowerCase(),
        repositoryId,
        () => parseJsonBody(context, patchGitHubRepositoryRequestSchema),
      ),
    );
    return jsonWithSchema(context, githubRepositoryWriteResponseSchema, set);
  });

  apiRoute(router, "listAgentGitHubRepositories", async (context) => {
    const { id } = requireParams(context, agentIdParamsSchema);
    const query = requireQuery(context, githubRepositoryPageQuerySchema);
    const listed = await mapped(() =>
      service.agentPage(context.get("caller"), id, query),
    );
    return jsonWithSchema(
      context,
      listAgentGitHubRepositoriesResponseSchema,
      listed,
    );
  });

  apiRoute(router, "pickAgentGitHubRepository", async (context) => {
    const { id } = requireParams(context, agentIdParamsSchema);
    const picked = await mapped(() =>
      service.pick(context.get("caller"), id, () =>
        parseJsonBody(context, pickAgentGitHubRepositoryRequestSchema),
      ),
    );
    return jsonWithSchema(
      context,
      pickAgentGitHubRepositoryResponseSchema,
      picked,
    );
  });
}
