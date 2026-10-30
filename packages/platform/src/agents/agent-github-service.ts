import {
  AGENT_GITHUB_ACTIVITY_LIMIT,
  type AgentGitHub,
  type AgentGitHubActivityResponse,
  type AgentGitHubFeatureUnavailable,
  type AgentGitHubRepositoryUnavailable,
  type AgentGitHubResponse,
  GITHUB_CEILING_NONE,
  type GitHubAppRole,
  type GitHubFeatures,
  type PutAgentGitHubEnabledResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND } from "../musterrolle/service-errors.ts";
import type { AgentGitHubStore } from "../ports/agent-github-store.ts";
import type { AgentStore } from "../ports/agent-store.ts";
import { repoRefOf } from "../ports/forge.ts";
import type { GitHubConnections } from "../ports/github-gate.ts";
import type { GitHubSettingsStore } from "../ports/github-settings.ts";
import {
  allowedPair,
  GITHUB_API_BASE,
  type SessionCatalog,
} from "../sessions/catalog.ts";
import {
  requirePermitted,
  SessionServiceError,
  viewerOf,
} from "../sessions/session-service.ts";

type Repository = SessionCatalog["repositories"][string];

const FEATURES: readonly (keyof GitHubFeatures)[] = [
  "workflows",
  "actions",
  "checks",
  "issues",
  "review",
];

/** Where a PAT works: github.com. Elsewhere a `basic` login is not GitHub's. */
function onGitHub(repository: Repository): boolean {
  if (repository.auth?.kind === "github_app") return true;
  if (repository.auth?.kind !== "basic") return false;
  try {
    return new URL(repository.url).origin === "https://github.com";
  } catch {
    return false;
  }
}

/** A catalog App on a GitHub Enterprise host: the default work only (§3). */
function enterpriseApp(repository: Repository | undefined): boolean {
  const auth = repository?.auth;
  return (
    auth?.kind === "github_app" &&
    "api_base" in auth &&
    auth.api_base !== GITHUB_API_BASE
  );
}

const writes = (level: string | undefined) =>
  level === "write" || level === "admin";

/**
 * The agent's GitHub tab (design github-agent.md §6, §7): the switch that
 * applies at once, what the active release pins, and what the tab may
 * offer. Whoever manages the agent reads it; the switch is turned from a
 * signed-in console session.
 */
export function createAgentGitHubService(deps: {
  authorization: AuthorizationPolicy;
  agents: Pick<AgentStore, "get">;
  store: AgentGitHubStore;
  catalog: SessionCatalog;
  githubSettings: Pick<GitHubSettingsStore, "get" | "appPermissions">;
  /** Each repository's connections, asked whether their App is installed. */
  connections?: GitHubConnections;
}) {
  const { authorization, catalog, store } = deps;

  // GitHub not answering leaves the badge off rather than failing the tab.
  async function installed(
    id: string,
    url: string,
    role: GitHubAppRole,
  ): Promise<boolean | null> {
    const connection = deps.connections?.(id, role) ?? null;
    const repo = repoRefOf(url);
    if (connection === null || repo === null) return null;
    return connection.installed(repo).catch(() => null);
  }

  const manage = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, "agent.manage", {
      kind: "agent",
      id: agentId,
    });

  return {
    async get(caller: Caller, agentId: string): Promise<AgentGitHubResponse> {
      await manage(caller, agentId);
      const workspaceId = caller.ownerId;
      const [detail, enabled, settings, apps] = await Promise.all([
        deps.agents.get(workspaceId, agentId),
        store.enabled(workspaceId, agentId),
        deps.githubSettings.get(workspaceId),
        deps.githubSettings.appPermissions(workspaceId),
      ]);
      if (detail === null || enabled === null) throw NOT_FOUND();
      const release = detail.active_release;
      const github = release?.policy_pins.github ?? null;
      const releaseRepository = release?.repository_id ?? null;
      const entry = (id: string) =>
        Object.hasOwn(catalog.repositories, id)
          ? catalog.repositories[id]
          : undefined;

      const repositories = (
        await Promise.all(
          Object.entries(catalog.repositories)
            .filter(([, repository]) => onGitHub(repository))
            .map(async ([id, repository]) => {
              const reason: AgentGitHubRepositoryUnavailable | null =
                release === null ||
                allowedPair(catalog, release.runtime_profile_id, id) === null
                  ? "repository_not_allowed"
                  : repository.auth?.kind !== "github_app"
                    ? "app_required"
                    : null;
              const [author, reviewer] = await Promise.all([
                installed(id, repository.url, "author"),
                installed(id, repository.url, "reviewer"),
              ]);
              return {
                id,
                url: repository.url,
                available: reason === null,
                reason,
                installed: { author, reviewer },
              };
            }),
        )
      ).sort((a, b) => a.id.localeCompare(b.id));

      const unsavable =
        release === null
          ? ("no_active_release" as const)
          : releaseRepository === null
            ? ("repository_none" as const)
            : entry(releaseRepository)?.auth?.kind !== "github_app"
              ? ("app_required" as const)
              : null;
      const legacyDefaults: AgentGitHub | null =
        github === null && unsavable === null && releaseRepository !== null
          ? {
              repositories: [releaseRepository],
              push_approval: true,
              features: { ...GITHUB_CEILING_NONE },
              actions_allow: [],
            }
          : null;

      // The gate decides at every token issue; these are what the tab shows
      // before it, from the ceiling and the permissions each App last read.
      const scope = github?.repositories ?? legacyDefaults?.repositories ?? [];
      const enterprise =
        scope.length > 0 && scope.every((id) => enterpriseApp(entry(id)));
      const author = apps.author?.permissions ?? null;
      const featureOption = (feature: keyof GitHubFeatures) => {
        const missing =
          feature === "review"
            ? apps.reviewer?.permissions != null &&
              !writes(apps.reviewer.permissions.pull_requests)
            : author !== null && !writes(author[feature]);
        const reason: AgentGitHubFeatureUnavailable | null = enterprise
          ? "github_host_unsupported"
          : !settings.ceiling[feature]
            ? "over_workspace_ceiling"
            : feature === "review" && apps.reviewer === null
              ? "no_reviewer_app"
              : missing
                ? "app_permission_missing"
                : null;
        return { available: reason === null, reason };
      };

      return {
        enabled,
        active_release_id: release?.id ?? null,
        release_repository_id: releaseRepository,
        github,
        legacy_defaults: legacyDefaults,
        unsavable,
        options: {
          repositories,
          features: Object.fromEntries(
            FEATURES.map((feature) => [feature, featureOption(feature)]),
          ) as AgentGitHubResponse["options"]["features"],
        },
      };
    },

    async putEnabled(
      caller: Caller,
      agentId: string,
      enabled: boolean,
    ): Promise<PutAgentGitHubEnabledResponse> {
      await manage(caller, agentId);
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user"
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "An agent's GitHub switch is turned from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const result = await store.setEnabled({
        workspaceId: caller.ownerId,
        agentId,
        enabled,
        principal: caller,
      });
      switch (result.outcome) {
        case "saved":
          return { enabled, receipt_id: result.receiptId };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          throw NOT_FOUND();
      }
    },

    async activity(
      caller: Caller,
      agentId: string,
    ): Promise<AgentGitHubActivityResponse> {
      await manage(caller, agentId);
      if ((await store.enabled(caller.ownerId, agentId)) === null) {
        throw NOT_FOUND();
      }
      return {
        items: await store.activity(
          caller.ownerId,
          agentId,
          viewerOf(caller),
          AGENT_GITHUB_ACTIVITY_LIMIT,
        ),
      };
    },
  };
}

export type AgentGitHubService = ReturnType<typeof createAgentGitHubService>;
