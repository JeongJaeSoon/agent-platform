import type {
  CreateSlackAppRequest,
  CreateSlackAppResponse,
  DeleteSlackAppResponse,
  GetSlackAppResponse,
  SlackApp,
  SlackWarning,
} from "@werft-ai/contracts";
import type {
  SlackAppActor,
  SlackAppRecord,
  SlackAppStore,
} from "../ports/slack-app-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import {
  type CreatedSlackApp,
  SlackApiError,
  type SlackConfigApi,
} from "./slack-config-api.ts";
import type { SlackConfigTokens } from "./slack-config-token.ts";
import {
  type AgentAppManifestInput,
  buildAgentAppManifest,
  slackAppRedirectUrl,
  slackAuthorizeUrl,
} from "./slack-manifest.ts";
import { slackSecretSummaryOf } from "./slack-secret-service.ts";

// Making or removing an agent's Slack app is installing Slack for that
// agent: `binding.manage` on it, which owner, admin and its admins hold.
const AGENT_ACTION = "binding.manage" as const;
const WORKSPACE_ACTION = "workspace.manage" as const;
/** Longer than the create call's timeout plus the write after it. */
export const SLACK_APP_CREATE_STALE_MS = 60_000;
const FINISH_ATTEMPTS = 3;
// Slack's answer when the app it is asked to delete no longer exists.
const GONE_CODES = new Set(["app_not_found", "invalid_app_id", "app_deleted"]);

const NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "Resource not found");
const FORBIDDEN_WEB_ONLY = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "Slack apps are managed from a signed-in console session, not with an API key",
    undefined,
    { reason_code: "web_session_required" },
  );
const ACTOR_INACTIVE = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "This principal is no longer a member of the workspace",
  );
const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds this right",
    undefined,
    { reason_code: "role" },
  );
const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
  );
const NO_CONSOLE_ORIGIN = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The console's address is not configured (SLACK_OIDC_REDIRECT_URI), so no OAuth redirect can be set",
  );
const creating = (app: SlackAppRecord, uncertain: boolean) =>
  new SessionServiceError(
    "SLACK_APP_CREATING",
    uncertain
      ? "An earlier creation of this agent's Slack app got no answer. Check api.slack.com/apps for it; if it is not there, ask again with replace_uncertain"
      : "This agent's Slack app is being created",
    undefined,
    { slack_app_id: app.id, uncertain },
  );
const slackRefused = (error: SlackApiError) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack refused ${error.method}: ${error.code}`,
    undefined,
    { slack_error: error.code },
  );
const answerLost = (method: string) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack's answer to ${method} was lost; asking again reports what is known`,
    { afterSeconds: 60 },
  );

export function slackAppView(record: SlackAppRecord): SlackApp {
  return {
    id: record.id,
    kind: record.kind,
    agent_id: record.agentId,
    state: record.state,
    app_id: record.appId,
    client_id: record.clientId,
    redirect_url: record.redirectUrl,
    created_by_token_user: record.createdByTokenUser,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    secrets: {
      slack_signing_secret: slackSecretSummaryOf(
        record.secrets.slack_signing_secret,
      ),
      slack_client_secret: slackSecretSummaryOf(
        record.secrets.slack_client_secret,
      ),
      slack_bot_token: slackSecretSummaryOf(record.secrets.slack_bot_token),
    },
  };
}

const authorizeUrlOf = (record: SlackAppRecord) =>
  record.state === "created" && record.clientId !== null
    ? slackAuthorizeUrl({
        clientId: record.clientId,
        redirectUrl: record.redirectUrl,
      })
    : null;

export type SlackAppService = ReturnType<typeof createSlackAppService>;

export function createSlackAppService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  apps: SlackAppStore | null;
  tokens: SlackConfigTokens | null;
  api: SlackConfigApi;
  /** The console's origin, from SLACK_OIDC_REDIRECT_URI; null when unset. */
  consoleOrigin: string | null;
  now?: () => Date;
  newId?: () => string;
}) {
  const { authorization, api } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  function ready() {
    if (deps.apps === null || deps.tokens === null) throw STORE_OFF();
    return { apps: deps.apps, tokens: deps.tokens };
  }

  function requireConsole(caller: Caller) {
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user"
    ) {
      throw FORBIDDEN_WEB_ONLY();
    }
  }

  async function permitAgent(caller: Caller, agentId: string) {
    await requirePermitted(authorization, caller, AGENT_ACTION, {
      kind: "agent",
      id: agentId,
    });
    requireConsole(caller);
  }

  const actorOf = (
    caller: Caller,
    action: typeof AGENT_ACTION | typeof WORKSPACE_ACTION,
  ): SlackAppActor => ({
    principal: caller,
    managerRoles: MANAGEMENT_ROLES[action] ?? [],
  });

  async function finish(
    apps: SlackAppStore,
    input: Parameters<SlackAppStore["finishCreate"]>[0],
  ): Promise<SlackAppRecord> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await apps.finishCreate(input);
      } catch {
        // The app exists in Slack and its secrets are only in memory; the
        // row stays `creating`, which a retry reports as uncertain.
        if (attempt >= FINISH_ATTEMPTS)
          throw answerLost("apps.manifest.create");
      }
    }
  }

  async function create(
    workspaceId: string,
    agentId: string,
    actor: SlackAppActor,
    request: CreateSlackAppRequest,
  ): Promise<CreateSlackAppResponse> {
    const { apps, tokens } = ready();
    if (deps.consoleOrigin === null) throw NO_CONSOLE_ORIGIN();
    const begun = await apps.beginAgentApp({
      workspaceId,
      agentId,
      actor,
      redirectUrl: slackAppRedirectUrl(deps.consoleOrigin, agentId),
      newId: newId(),
      staleBefore: new Date(now().getTime() - SLACK_APP_CREATE_STALE_MS),
      replaceUncertain: request.replace_uncertain,
    });
    switch (begun.outcome) {
      case "agent_not_found":
        throw NOT_FOUND();
      case "agent_not_active":
        throw new SessionServiceError(
          "AGENT_NOT_ACTIVE",
          "Activate a release of this agent before creating its Slack app",
        );
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      case "creating":
        throw creating(begun.app, begun.uncertain);
      case "exists": {
        const url = authorizeUrlOf(begun.app);
        if (url === null) {
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "This agent's Slack app is being deleted",
          );
        }
        return {
          slack_app: slackAppView(begun.app),
          authorize_url: url,
          created: false,
          warnings: [],
        };
      }
    }
    const manifestInput: AgentAppManifestInput = {
      name: begun.agent.name,
      botName: begun.agent.slug,
      description: begun.agent.role,
      redirectUrl: begun.app.redirectUrl,
    };
    const previousTokenUser = await apps.lastTokenUser(workspaceId);
    let called = false;
    let created: { app: CreatedSlackApp; tokenUserId: string };
    try {
      created = await tokens.withToken(workspaceId, async (token, issuer) => {
        called = true;
        return {
          app: await api.createApp(token, buildAgentAppManifest(manifestInput)),
          tokenUserId: issuer,
        };
      });
    } catch (error) {
      const refused =
        !called ||
        (error instanceof SlackApiError && error.answered) ||
        (error instanceof SessionServiceError &&
          error.code === "CONFIG_TOKEN_INVALID");
      if (!refused) throw answerLost("apps.manifest.create");
      await apps.failCreate(workspaceId, begun.app.id);
      if (error instanceof SlackApiError) throw slackRefused(error);
      throw error;
    }
    const record = await finish(apps, {
      workspaceId,
      slackAppId: begun.app.id,
      created: created.app,
      tokenUserId: created.tokenUserId,
    });
    const warnings: SlackWarning[] =
      previousTokenUser !== null && previousTokenUser !== created.tokenUserId
        ? [
            {
              code: "config_token_issuer_changed",
              previous_user_id: previousTokenUser,
              user_id: created.tokenUserId,
            },
          ]
        : [];
    const url = authorizeUrlOf(record);
    if (url === null) throw new Error("created Slack app has no client id");
    return {
      slack_app: slackAppView(record),
      authorize_url: url,
      created: true,
      warnings,
    };
  }

  return {
    async createAgentApp(
      caller: Caller,
      agentId: string,
      request: CreateSlackAppRequest,
    ): Promise<CreateSlackAppResponse> {
      await permitAgent(caller, agentId);
      return create(
        caller.ownerId,
        agentId,
        actorOf(caller, AGENT_ACTION),
        request,
      );
    },

    /** The operator's CLI: whoever holds the database holds this right. */
    createAgentAppAsOperator(
      workspaceId: string,
      agentId: string,
      request: CreateSlackAppRequest,
    ): Promise<CreateSlackAppResponse> {
      return create(workspaceId, agentId, null, request);
    },

    async getAgentApp(
      caller: Caller,
      agentId: string,
    ): Promise<GetSlackAppResponse> {
      await permitAgent(caller, agentId);
      const { apps } = ready();
      const record = await apps.findForAgent(caller.ownerId, agentId);
      return {
        slack_app: record === null ? null : slackAppView(record),
        authorize_url: record === null ? null : authorizeUrlOf(record),
      };
    },

    async deleteApp(
      caller: Caller,
      workspaceId: string,
      slackAppId: string,
    ): Promise<DeleteSlackAppResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      const { apps, tokens } = ready();
      const found = await apps.find(workspaceId, slackAppId);
      if (found === null) throw NOT_FOUND();
      const action = found.agentId === null ? WORKSPACE_ACTION : AGENT_ACTION;
      await requirePermitted(
        authorization,
        caller,
        action,
        found.agentId === null
          ? { kind: "workspace", id: workspaceId }
          : { kind: "agent", id: found.agentId },
      );
      requireConsole(caller);
      const begun = await apps.beginDelete({
        workspaceId,
        slackAppId,
        actor: actorOf(caller, action),
      });
      switch (begun.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "creating":
          throw creating(begun.app, true);
        case "settled":
          return { slack_app: slackAppView(begun.app) };
      }
      const appId = begun.app.appId;
      if (appId === null) throw new Error("deleting Slack app has no app id");
      try {
        await tokens.withToken(workspaceId, (token) =>
          api.deleteApp(token, appId),
        );
      } catch (error) {
        if (!(error instanceof SlackApiError)) throw error;
        if (!(error.answered && GONE_CODES.has(error.code))) {
          throw error.answered
            ? slackRefused(error)
            : answerLost("apps.manifest.delete");
        }
      }
      return {
        slack_app: slackAppView(
          await apps.finishDelete(workspaceId, slackAppId),
        ),
      };
    },

    /**
     * Sends the whole manifest for one of the workspace's own apps. The
     * app id is read from `slack_apps`, never taken from a caller, so the
     * token cannot be pointed at an app the platform did not make here.
     */
    async updateAgentAppManifest(
      workspaceId: string,
      slackAppId: string,
      input: Omit<AgentAppManifestInput, "redirectUrl">,
    ): Promise<{ permissionsUpdated: boolean }> {
      const { apps, tokens } = ready();
      const record = await apps.find(workspaceId, slackAppId);
      if (record === null || record.state !== "created" || !record.appId) {
        throw NOT_FOUND();
      }
      const appId = record.appId;
      const manifest = buildAgentAppManifest({
        ...input,
        redirectUrl: record.redirectUrl,
      });
      try {
        return await tokens.withToken(workspaceId, (token) =>
          api.updateApp(token, appId, manifest),
        );
      } catch (error) {
        if (error instanceof SlackApiError) {
          throw error.answered
            ? slackRefused(error)
            : answerLost("apps.manifest.update");
        }
        throw error;
      }
    },
  };
}
