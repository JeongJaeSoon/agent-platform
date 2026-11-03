import {
  type AgentCard,
  type AgentGitHub,
  type AuthorizationSurface,
  githubRepositoryNameSchema,
  type PlatformPrompt,
  type PlatformPromptSurface,
} from "@werft-ai/contracts";
import { additionalRepositoriesOf } from "./additional-repositories.ts";
import type { SessionCatalogView } from "./catalog.ts";
import { pathNameOf } from "./session-repository.ts";

/**
 * The revisions of the platform prompt a new session may be given. 0 gives
 * none, as every session from before it; an installation raises it only once
 * every control-host replica and every worker image it runs knows the
 * revision (`SESSION_PROMPT_REVISION`).
 */
export const PLATFORM_PROMPT_REVISIONS = [0, 1] as const;
export type PlatformPromptRevision = (typeof PLATFORM_PROMPT_REVISIONS)[number];

export function platformPromptRevisionFromEnv(
  environment: Record<string, string | undefined>,
): PlatformPromptRevision {
  const raw = environment.SESSION_PROMPT_REVISION ?? "";
  if (raw === "") return 0;
  const revision = PLATFORM_PROMPT_REVISIONS.find(
    (known) => String(known) === raw,
  );
  if (revision === undefined) {
    throw new Error(
      `SESSION_PROMPT_REVISION must be one of ${PLATFORM_PROMPT_REVISIONS.join(", ")}`,
    );
  }
  return revision;
}

/** The agent as a session snapshots it, read when the session is created. */
export type AgentPromptIdentity = {
  name: string;
  description: string | null;
  language: AgentCard["language"];
};

/**
 * The platform prompt of a session being created for an agent release. The
 * repositories are the ones the release and the catalog allow at creation,
 * whatever is attached: list_repositories answers that later.
 */
export function platformPromptOf(input: {
  identity: AgentPromptIdentity;
  surface: AuthorizationSurface;
  catalog: SessionCatalogView;
  profileId: string;
  repository: { id: string; url: string } | null;
  github: AgentGitHub | null;
}): PlatformPrompt {
  const { identity, repository, github } = input;
  const own = repository === null ? null : githubNameOf(repository.url);
  const others =
    github === null
      ? []
      : additionalRepositoriesOf(input.catalog, {
          repositoryId: repository?.id ?? null,
          profileId: input.profileId,
          attached: null,
          github,
          githubEnabled: true,
        }).flatMap(({ repository: other }) => {
          const name = githubNameOf(other.url);
          return name === null ? [] : [name];
        });
  return {
    prompt_revision: 1,
    agent_identity: {
      name: identity.name,
      description:
        identity.description === null || identity.description.trim() === ""
          ? null
          : identity.description,
    },
    origin_surface: surfaceOf(input.surface),
    language: identity.language,
    repository: own,
    github:
      github === null
        ? null
        : {
            repositories: [
              ...new Set([...(own === null ? [] : [own]), ...others]),
            ],
          },
  };
}

// A catalog URL whose path is not `owner/repo` gives no name: the prompt
// never falls back to the URL or the workspace path.
function githubNameOf(url: string): string | null {
  const name = pathNameOf(url);
  return name !== null && githubRepositoryNameSchema.safeParse(name).success
    ? name
    : null;
}

function surfaceOf(surface: AuthorizationSurface): PlatformPromptSurface {
  switch (surface.kind) {
    case "web":
      return "console";
    case "api":
      return "api";
    case "slack":
      return surface.channel_kind === "dm" ? "slack_dm" : "slack_channel";
  }
}
