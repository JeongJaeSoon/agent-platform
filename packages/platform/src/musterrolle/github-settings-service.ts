import type {
  GitHubSettingsResponse,
  PutGitHubSettingsRequest,
} from "@werft-ai/contracts";
import type { GitHubSettingsStore } from "../ports/github-settings.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  receiptActorOf,
} from "./policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND } from "./service-errors.ts";

/**
 * The workspace's GitHub ceiling (design github-agent.md decision 9): what
 * its agents may turn on. Members read it; an owner or admin signed in to
 * the console changes it. The gate applies it at every token issue, so a
 * lowered ceiling refuses the next one.
 */
export function createGitHubSettingsService(deps: {
  authorization: AuthorizationPolicy;
  store: GitHubSettingsStore;
}) {
  const { authorization, store } = deps;

  async function read(workspaceId: string): Promise<GitHubSettingsResponse> {
    const [settings, agentsUsing, apps] = await Promise.all([
      store.get(workspaceId),
      store.agentsUsing(workspaceId),
      store.appPermissions(workspaceId),
    ]);
    return { ...settings, agents_using: agentsUsing, apps };
  }

  return {
    async get(
      caller: Caller,
      workspaceId: string,
    ): Promise<GitHubSettingsResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      // Any member reads it; the policy has no read action for a workspace.
      if (caller.subject.principal?.kind !== "user") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "The GitHub settings are read by a workspace member",
        );
      }
      return await read(workspaceId);
    },

    async put(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubSettingsRequest>,
    ): Promise<GitHubSettingsResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      await requirePermitted(authorization, caller, "workspace.manage", {
        kind: "workspace",
        id: workspaceId,
      });
      const principal = caller.subject.principal;
      if (caller.subject.surface.kind !== "web" || principal?.kind !== "user") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "The GitHub ceiling is set from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const body = await readBody();
      const actor = receiptActorOf(caller);
      if (actor === null) throw ACTOR_INACTIVE();
      const result = await store.putCeiling({
        workspaceId,
        ceiling: body.ceiling,
        revision: body.revision,
        updatedBy: principal.id,
        actor,
      });
      switch (result.outcome) {
        case "stored":
          return await read(workspaceId);
        case "revision_conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The GitHub settings changed since they were read",
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type GitHubSettingsService = ReturnType<
  typeof createGitHubSettingsService
>;
