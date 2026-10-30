import type {
  GitHubOAuth,
  GitHubSettingsResponse,
  PutGitHubOAuthClientSecretRequest,
  PutGitHubOAuthClientSecretResponse,
  PutGitHubSettingsRequest,
} from "@werft-ai/contracts";
import type {
  GitHubOAuthStore,
  GitHubSettingsStore,
} from "../ports/github-settings.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  receiptActorOf,
} from "./policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND, OUTRANKED } from "./service-errors.ts";

const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];

const noAuthorApp = () =>
  new SessionServiceError(
    "GITHUB_LINK_NOT_CONFIGURED",
    "Register the author GitHub App before its client secret",
    undefined,
    { reason_code: "no_author_app" },
  );

/**
 * The workspace's GitHub ceiling (design github-agent.md decision 9): what
 * its agents may turn on. Members read it; an owner or admin signed in to
 * the console changes it. The gate applies it at every token issue, so a
 * lowered ceiling refuses the next one.
 */
export function createGitHubSettingsService(deps: {
  authorization: AuthorizationPolicy;
  store: GitHubSettingsStore;
  oauth: GitHubOAuthStore;
  /** Null when the console has no origin to be called back on. */
  callbackUrl: string | null;
  /** False when the API runs without a master key: no secret can be kept. */
  secretsOn: boolean;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function oauthOf(workspaceId: string): Promise<GitHubOAuth> {
    const status = await deps.oauth.status(workspaceId);
    return {
      client_id: status.clientId,
      client_secret_set: status.clientSecretSet,
      callback_url: deps.callbackUrl,
    };
  }

  async function read(workspaceId: string): Promise<GitHubSettingsResponse> {
    const [settings, agentsUsing, apps, oauth] = await Promise.all([
      store.get(workspaceId),
      store.agentsUsing(workspaceId),
      store.appPermissions(workspaceId),
      oauthOf(workspaceId),
    ]);
    return { ...settings, agents_using: agentsUsing, oauth, apps };
  }

  async function requireConsoleManager(
    caller: Caller,
    workspaceId: string,
    what: string,
  ) {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    const principal = caller.subject.principal;
    if (caller.subject.surface.kind !== "web" || principal?.kind !== "user") {
      throw new SessionServiceError(
        "FORBIDDEN",
        `${what} is set from a signed-in console session, not with an API key`,
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    return principal;
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
      const principal = await requireConsoleManager(
        caller,
        workspaceId,
        "The GitHub ceiling",
      );
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

    /**
     * The author App's client secret for linking people's accounts. Sealed
     * like the App's key and never answered back, not even in part: the
     * receipt keeps its last four characters, as for every secret.
     */
    async putOAuthClientSecret(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubOAuthClientSecretRequest>,
    ): Promise<PutGitHubOAuthClientSecretResponse> {
      await requireConsoleManager(
        caller,
        workspaceId,
        "The OAuth client secret",
      );
      if (!deps.secretsOn) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
        );
      }
      // Refused before the secret is read; the store checks again under its lock.
      if (!(await deps.oauth.status(workspaceId)).authorApp) {
        throw noAuthorApp();
      }
      const body = await readBody();
      const receiptId = newId();
      const result = await deps.oauth.putClientSecret(
        workspaceId,
        body.client_secret,
        { principal: caller, receiptId, roles: MANAGERS },
      );
      switch (result.outcome) {
        case "stored":
          return { receipt_id: receiptId, oauth: await oauthOf(workspaceId) };
        case "no_author_app":
          throw noAuthorApp();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type GitHubSettingsService = ReturnType<
  typeof createGitHubSettingsService
>;
