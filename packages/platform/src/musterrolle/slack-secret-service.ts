import type {
  DeleteSlackSecretResponse,
  PutSlackSecretResponse,
  SecretPurpose,
  SlackSecretSummary,
} from "@werft-ai/contracts";
import type {
  PutSecretResult,
  SecretSlot,
  SecretStore,
  SecretSummary,
} from "../ports/secret-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";

// The write-only Slack secrets a person sets from the console: owners and
// admins, in a browser session (so the CSRF checks apply), never a key.
// Values go in; only whether one is set and its last four come back.

export type SlackAppKind = "agent" | "link" | "manual";
export type SlackAppSecretPurpose = Exclude<
  SecretPurpose,
  "slack_config_token"
>;

const FORBIDDEN_WEB_ONLY = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "Slack secrets are set from a signed-in console session, not with an API key",
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
const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];
const NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "Resource not found");
const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
  );

export function slackSecretSummaryOf(
  summary: SecretSummary | null,
): SlackSecretSummary {
  if (summary === null) {
    return { configured: false, last4: null, updated_at: null, updated_by: null };
  }
  return {
    configured: true,
    last4: summary.last4,
    updated_at: summary.updatedAt.toISOString(),
    updated_by:
      summary.updatedBy === null
        ? null
        : {
            user_id: summary.updatedBy.userId,
            display_name: summary.updatedBy.displayName,
          },
  };
}

export function createSlackSecretService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  store: SecretStore | null;
  /**
   * The kind of one of the workspace's Slack apps, or null when it has no
   * such app. Supplied once `slack_apps` exists (94S-181); until then no
   * app secret can be set by a person.
   */
  appKind?: (workspaceId: string, appId: string) => Promise<SlackAppKind | null>;
  newId?: () => string;
}) {
  const { authorization } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function managedStore(
    caller: Caller,
    workspaceId: string,
  ): Promise<SecretStore> {
    // requirePermitted scopes the decision to the caller's own workspace,
    // so a path naming another one has to be refused here.
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user"
    ) {
      throw FORBIDDEN_WEB_ONLY();
    }
    if (deps.store === null) throw STORE_OFF();
    return deps.store;
  }

  async function put(
    caller: Caller,
    store: SecretStore,
    slot: SecretSlot,
    value: string,
  ): Promise<PutSlackSecretResponse> {
    const receiptId = newId();
    const result: PutSecretResult = await store.put(slot, value, {
      audit: { principal: caller, receiptId, roles: MANAGERS },
    });
    switch (result.outcome) {
      case "stored":
        return {
          ...slackSecretSummaryOf(result.summary),
          receipt_id: receiptId,
        };
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      default:
        throw NOT_FOUND();
    }
  }

  const configToken = (workspaceId: string): SecretSlot => ({
    workspaceId,
    owner: { kind: "workspace" },
    purpose: "slack_config_token",
  });

  return {
    async describeConfigToken(
      caller: Caller,
      workspaceId: string,
    ): Promise<SlackSecretSummary> {
      const store = await managedStore(caller, workspaceId);
      return slackSecretSummaryOf(
        await store.describe(configToken(workspaceId)),
      );
    },

    async setConfigToken(
      caller: Caller,
      workspaceId: string,
      value: string,
    ): Promise<PutSlackSecretResponse> {
      const store = await managedStore(caller, workspaceId);
      return put(caller, store, configToken(workspaceId), value);
    },

    async deleteConfigToken(
      caller: Caller,
      workspaceId: string,
    ): Promise<DeleteSlackSecretResponse> {
      const store = await managedStore(caller, workspaceId);
      const receiptId = newId();
      const result = await store.delete(configToken(workspaceId), {
        audit: { principal: caller, receiptId, roles: MANAGERS },
      });
      switch (result.outcome) {
        case "deleted":
          return { receipt_id: receiptId };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    /**
     * A manual app's own values. An app the platform created keeps secrets
     * only the server writes: an admin who knew its signing secret could
     * sign events as Slack and act as any member.
     */
    async setAppSecret(
      caller: Caller,
      workspaceId: string,
      appId: string,
      purpose: SlackAppSecretPurpose,
      value: string,
    ): Promise<PutSlackSecretResponse> {
      const store = await managedStore(caller, workspaceId);
      const kind = (await deps.appKind?.(workspaceId, appId)) ?? null;
      if (kind === null) throw NOT_FOUND();
      if (kind !== "manual") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "This Slack app's secrets are written by the platform only",
          undefined,
          { reason_code: "server_managed_secret" },
        );
      }
      return put(
        caller,
        store,
        { workspaceId, owner: { kind: "slack_app", id: appId }, purpose },
        value,
      );
    },
  };
}

export type SlackSecretService = ReturnType<typeof createSlackSecretService>;
