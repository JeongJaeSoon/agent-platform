import {
  type AgentGitHub,
  additionalRepositoryIdUsable,
} from "@werft-ai/contracts";
import {
  allowedPair,
  type CatalogProfileView,
  type CatalogRepositoryView,
  type ProfileLookup,
} from "./catalog.ts";

/**
 * What decides whether a session may work on a repository other than its
 * own (design session-multi-repository.md decision 1): read again on every
 * use, so a repository the owner takes off the release's list stops at the
 * next fetch, push or pull request.
 */
export type AdditionalRepositoryContext = {
  repositoryId: string | null;
  profileId: string | null;
  /** Null when the session has no agent, or the agent's switch is off. */
  github: AgentGitHub | "invalid" | null;
  githubEnabled: boolean;
};

export function additionalRepositoryAllowed<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  context: AdditionalRepositoryContext,
  repositoryId: string,
): R | null {
  const { github, profileId } = context;
  if (
    repositoryId === context.repositoryId ||
    !context.githubEnabled ||
    github === null ||
    github === "invalid" ||
    profileId === null ||
    !github.repositories.includes(repositoryId) ||
    !additionalRepositoryIdUsable(repositoryId)
  ) {
    return null;
  }
  return allowedPair(catalog, profileId, repositoryId)?.repository ?? null;
}

/** Every repository besides its own the session may work on, in list order. */
export function additionalRepositoriesOf<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  context: AdditionalRepositoryContext,
): Array<{ id: string; repository: R }> {
  const github = context.github;
  if (github === null || github === "invalid") return [];
  return github.repositories.flatMap((id) => {
    const repository = additionalRepositoryAllowed(catalog, context, id);
    return repository === null ? [] : [{ id, repository }];
  });
}
