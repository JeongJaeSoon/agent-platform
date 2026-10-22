import {
  API_KEY_LIST_LIMIT,
  type ApiKeyView,
  type AuthorizationAction,
  type AuthorizationResource,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type ListApiKeysResponse,
  type RevokeApiKeyResponse,
} from "@werft-ai/contracts";
import type {
  WorkspaceKey,
  WorkspaceKeyStore,
} from "../ports/api-key-store.ts";
import {
  requireAllowed,
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";

// Keys issued by a person (design 4.1): their own personal key, a
// workspace's service key, or a service key bound to an agent they
// administer. An API key is never a person, so the policy refuses it here.

const NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "Resource not found");
// The caller's role fell between the decision and the write.
const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds this right",
    undefined,
    { reason_code: "role" },
  );
const ACTOR_INACTIVE = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "This principal is no longer a member of the workspace",
  );

export function viewOf(key: WorkspaceKey): ApiKeyView {
  return {
    id: key.id,
    kind: key.kind,
    workspace_id: key.workspaceId,
    agent_id: key.agentId,
    created_by: key.createdByUserId,
    scopes: [...key.scopes],
    created_at: key.createdAt.toISOString(),
    expires_at: key.expiresAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
  };
}

export function createApiKeyService(deps: {
  authorization: AuthorizationPolicy;
  store: WorkspaceKeyStore;
  /** A fresh secret and the hash the store keeps in its place. */
  mint: () => { secret: string; hash: Uint8Array };
  newId?: () => string;
  now?: () => Date;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  function personOf(caller: Caller): string {
    const userId = caller.actor?.userId;
    // The policy already refused anyone else; this keeps a key row from
    // ever being written without its issuer.
    if (caller.subject.principal?.kind !== "user" || !userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person issues or revokes keys",
        undefined,
        { reason_code: "role" },
      );
    }
    return userId;
  }

  // The right that issuing or revoking this kind of key takes.
  function rightFor(
    caller: Caller,
    key: { kind: WorkspaceKey["kind"]; agentId: string | null },
  ): [AuthorizationAction, Omit<AuthorizationResource, "owner_scope">] {
    if (key.kind === "personal") {
      return ["api_key.manage_own", { kind: "workspace", id: caller.ownerId }];
    }
    return key.agentId === null
      ? ["api_key.manage", { kind: "workspace", id: caller.ownerId }]
      : ["api_key.manage", { kind: "agent", id: key.agentId }];
  }

  return {
    async issue(
      caller: Caller,
      body: CreateApiKeyRequest,
    ): Promise<CreateApiKeyResponse> {
      const agentId = body.agent_id?.toLowerCase() ?? null;
      const [action, resource] = rightFor(caller, { kind: body.kind, agentId });
      const decision = await requireAllowed(
        authorization,
        caller,
        action,
        resource,
      );
      const userId = personOf(caller);
      // Read at this decision, so a role lowered a moment ago already caps
      // the key (design 4.1: never more than the issuer holds now).
      const held = new Set(decision.effective_scopes);
      const beyond = body.scopes.filter((scope) => !held.has(scope));
      if (beyond.length > 0) {
        throw new SessionServiceError(
          "SCOPE_NOT_GRANTABLE",
          `The issuer does not hold ${beyond.join(", ")}`,
        );
      }
      if (agentId !== null && body.scopes.includes("sessions:approve")) {
        throw new SessionServiceError(
          "SCOPE_NOT_GRANTABLE",
          "A key bound to an agent never approves (D26)",
        );
      }
      const expiresAt =
        body.expires_at === undefined ? null : new Date(body.expires_at);
      if (expiresAt !== null && expiresAt.getTime() <= now().getTime()) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "expires_at must be in the future",
        );
      }
      const { secret, hash } = deps.mint();
      const receiptId = newId();
      const result = await store.issue({
        principal: caller,
        id: newId(),
        workspaceId: caller.ownerId,
        keyHash: hash,
        kind: body.kind,
        agentId,
        createdByUserId: userId,
        scopes: [...new Set(body.scopes)],
        expiresAt,
        receiptId,
        issuerRoles: MANAGEMENT_ROLES[action] ?? [],
      });
      switch (result.outcome) {
        case "issued":
          break;
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "scope_not_grantable":
          throw new SessionServiceError(
            "SCOPE_NOT_GRANTABLE",
            "The issuer no longer holds these scopes",
          );
        default:
          throw NOT_FOUND();
      }
      return { key: viewOf(result.key), secret, receipt_id: receiptId };
    },

    async list(caller: Caller): Promise<ListApiKeysResponse> {
      await requirePermitted(authorization, caller, "api_key.manage_own", {
        kind: "workspace",
        id: caller.ownerId,
      });
      const userId = personOf(caller);
      // Who sees every service key is the role table's, applied by the store
      // to the role held now; a refused probe would record a denial for
      // each listing.
      const keys = await store.list(
        caller.ownerId,
        {
          personalOf: userId,
          allServiceKeysFor: MANAGEMENT_ROLES["api_key.manage"] ?? [],
        },
        API_KEY_LIST_LIMIT,
      );
      return { items: keys.map(viewOf) };
    },

    async revoke(caller: Caller, keyId: string): Promise<RevokeApiKeyResponse> {
      const userId = personOf(caller);
      const key = await store.find(caller.ownerId, keyId);
      // Another person's personal key is not the caller's to see.
      if (!key || (key.kind === "personal" && key.createdByUserId !== userId)) {
        throw NOT_FOUND();
      }
      const [action, resource] = rightFor(caller, key);
      await requirePermitted(authorization, caller, action, resource);
      const receiptId = newId();
      const result = await store.revoke({
        principal: caller,
        workspaceId: caller.ownerId,
        keyId: key.id,
        receiptId,
        revokerRoles: MANAGEMENT_ROLES[action] ?? [],
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "already_revoked":
          return { key: viewOf(result.key), receipt_id: null };
        default:
          return { key: viewOf(result.key), receipt_id: receiptId };
      }
    },
  };
}
export type ApiKeyService = ReturnType<typeof createApiKeyService>;
