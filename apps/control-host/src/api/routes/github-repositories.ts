import {
  deleteGitHubRepositoryResponseSchema,
  githubRepositoryParamsSchema,
  githubRepositoryWriteResponseSchema,
  listGitHubRepositoriesResponseSchema,
  listGitHubRepositoryCandidatesResponseSchema,
  patchGitHubRepositoryRequestSchema,
  postGitHubRepositoryRequestSchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { GitHubRepositoryService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerGitHubRepositoryRoutes(
  router: ApiRouter,
  service: GitHubRepositoryService,
) {
  apiRoute(router, "listGitHubRepositories", async (context) => {
    const { id } = requireParams(context, workspaceParamsSchema);
    const listed = await mapped(() =>
      service.list(context.get("caller"), id.toLowerCase()),
    );
    return jsonWithSchema(
      context,
      listGitHubRepositoriesResponseSchema,
      listed,
    );
  });

  apiRoute(router, "listGitHubRepositoryCandidates", async (context) => {
    const { id } = requireParams(context, workspaceParamsSchema);
    const listed = await mapped(() =>
      service.candidates(context.get("caller"), id.toLowerCase()),
    );
    return jsonWithSchema(
      context,
      listGitHubRepositoryCandidatesResponseSchema,
      listed,
    );
  });

  apiRoute(router, "addGitHubRepository", async (context) => {
    const { id } = requireParams(context, workspaceParamsSchema);
    const added = await mapped(() =>
      service.add(context.get("caller"), id.toLowerCase(), () =>
        parseJsonBody(context, postGitHubRepositoryRequestSchema),
      ),
    );
    return jsonWithSchema(
      context,
      githubRepositoryWriteResponseSchema,
      added,
      201,
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

  apiRoute(router, "deleteGitHubRepository", async (context) => {
    const { id, repositoryId } = requireParams(
      context,
      githubRepositoryParamsSchema,
    );
    const removed = await mapped(() =>
      service.remove(context.get("caller"), id.toLowerCase(), repositoryId),
    );
    return jsonWithSchema(
      context,
      deleteGitHubRepositoryResponseSchema,
      removed,
    );
  });
}
