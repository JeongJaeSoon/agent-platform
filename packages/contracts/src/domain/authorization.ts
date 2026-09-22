import { z } from "zod";

import {
  agentIdSchema,
  grantIdSchema,
  opaqueIdSchema,
  revisionSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

// ---------------------------------------------------------------------------
// Scopes and roles
// ---------------------------------------------------------------------------

// 94S-132's API key scopes. Users get the same vocabulary derived from a role
// so one ceiling check covers both authentication paths (03 §3.2).
export const SESSION_SCOPE_VALUES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
] as const;
export const sessionScopeSchema = z.enum(SESSION_SCOPE_VALUES);

export const WORKSPACE_ROLE_VALUES = ["owner", "member"] as const;
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLE_VALUES);

export type SessionScope = z.infer<typeof sessionScopeSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

// 03 §3.2: owner gets everything, member everything but recovery.
const MEMBER_SCOPES = SESSION_SCOPE_VALUES.filter(
  (scope) => scope !== "sessions:recover",
);

export function scopesForRole(role: WorkspaceRole): readonly SessionScope[] {
  return role === "owner" ? SESSION_SCOPE_VALUES : MEMBER_SCOPES;
}

// ---------------------------------------------------------------------------
// Principal and authorization context
// ---------------------------------------------------------------------------

export const PRINCIPAL_KIND_VALUES = ["api_key", "user"] as const;
export const principalKindSchema = z.enum(PRINCIPAL_KIND_VALUES);

/** Just enough to name who is acting; the full principal carries the ceiling. */
export const principalRefSchema = z
  .object({ kind: principalKindSchema, id: opaqueIdSchema })
  .strict();

export const principalSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("api_key"),
        id: opaqueIdSchema,
        owner_id: opaqueIdSchema,
        // Legacy keys predate workspaces and stay unmapped until an explicit
        // owner_workspace_map row exists (94S-150, Codex B18).
        workspace_id: workspaceIdSchema.nullable(),
        scopes: z.array(sessionScopeSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("user"),
        id: userIdSchema,
        workspace_id: workspaceIdSchema,
        role: workspaceRoleSchema,
        scopes: z.array(sessionScopeSchema),
      })
      .strict(),
  ])
  .superRefine((principal, ctx) => {
    if (principal.kind !== "user") return;
    // The role is the ceiling, not a label beside it: a membership may hand a
    // user fewer scopes than the role allows, never more. Without this a
    // `member` row carrying `sessions:recover` would walk straight through
    // `authorizationContextFor` into owner-only recovery.
    const allowed = new Set(scopesForRole(principal.role));
    for (const scope of principal.scopes) {
      if (!allowed.has(scope)) {
        ctx.addIssue({
          code: "custom",
          path: ["scopes"],
          message: `${principal.role} cannot hold ${scope}`,
        });
      }
    }
  });

/**
 * What every route hands to a domain service.
 *
 * `owner_scope` is alpha's partition key: every legacy consumer authorizes on
 * it alone, so an API key request keeps behaving exactly as it did before
 * workspaces existed (Codex B01).
 */
export const authorizationContextSchema = z
  .object({
    principal: principalRefSchema,
    /** The human behind the request when the principal is not itself one. */
    actor_user_id: userIdSchema.optional(),
    owner_scope: opaqueIdSchema,
    workspace_id: workspaceIdSchema.optional(),
    /** The 94S-132 ceiling carried with the context, never re-derived downstream. */
    scopes: z.array(sessionScopeSchema),
  })
  .strict();

export type PrincipalKind = z.infer<typeof principalKindSchema>;
export type PrincipalRef = z.infer<typeof principalRefSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type AuthorizationContext = z.infer<typeof authorizationContextSchema>;

/** What `platform/src/authorization/policy.ts` still consumes. */
export type LegacyPrincipal = { ownerId: string };

export function toLegacyPrincipal(ctx: AuthorizationContext): LegacyPrincipal {
  return { ownerId: ctx.owner_scope };
}

/**
 * Lift an alpha API key principal into a context.
 *
 * `findOwner()` returns only the owner today, so the key id doubles as the
 * principal id until 94S-132 hands back `{keyId, ownerId, scopes}`.
 */
export function authorizationContextFromLegacy(
  principal: LegacyPrincipal,
  scopes: readonly SessionScope[] = SESSION_SCOPE_VALUES,
): AuthorizationContext {
  return {
    principal: { kind: "api_key", id: principal.ownerId },
    owner_scope: principal.ownerId,
    scopes: [...scopes],
  };
}

export function authorizationContextFor(
  principal: Principal,
): AuthorizationContext {
  if (principal.kind === "api_key") {
    return {
      principal: { kind: "api_key", id: principal.id },
      owner_scope: principal.owner_id,
      ...(principal.workspace_id === null
        ? {}
        : { workspace_id: principal.workspace_id }),
      scopes: [...principal.scopes],
    };
  }
  return {
    principal: { kind: "user", id: principal.id },
    actor_user_id: principal.id,
    // A user acts inside their workspace; the owner partition is the
    // workspace itself so rows created either way stay readable (94S-150).
    owner_scope: principal.workspace_id,
    workspace_id: principal.workspace_id,
    scopes: [...principal.scopes],
  };
}

// ---------------------------------------------------------------------------
// Idempotency principal
// ---------------------------------------------------------------------------

// `kind:id` keeps replay windows from colliding across authentication paths:
// the same Idempotency-Key from an API key and from a cookie session are two
// different requests (Codex B04).
export const IDEMPOTENCY_PRINCIPAL_KIND_VALUES = [
  "api_key",
  "user",
  "slack",
] as const;
export const idempotencyPrincipalKindSchema = z.enum(
  IDEMPOTENCY_PRINCIPAL_KIND_VALUES,
);
// Alpha owner ids are an unconstrained `text` column, so each id is
// percent-encoded before it joins the string: a tenant whose id holds a space,
// a slash, a colon or Hangul still yields exactly one principal instead of
// throwing on the way in. `:` survives encoding only as the kind separator, so
// the split stays unambiguous. No length cap — `idempotency_keys.principal` is
// `text` and alpha stored the bare owner id there with none either.
const ENCODED_SEGMENT = "[A-Za-z0-9\\-_.!~*'()%]+";
export const idempotencyPrincipalSchema = z
  .string()
  .regex(
    new RegExp(
      `^(api_key|user|slack):${ENCODED_SEGMENT}(?::${ENCODED_SEGMENT})*$`,
    ),
    "must be kind:id, e.g. user:<uuid> or slack:<team>:<user>",
  );

export type IdempotencyPrincipalKind = z.infer<
  typeof idempotencyPrincipalKindSchema
>;

export function formatIdempotencyPrincipal(
  kind: IdempotencyPrincipalKind,
  ...ids: readonly string[]
): string {
  const encoded = ids.map((id) => {
    if (id.length === 0) {
      throw new TypeError("idempotency principal: empty id segment");
    }
    return encodeURIComponent(id);
  });
  return idempotencyPrincipalSchema.parse([kind, ...encoded].join(":"));
}

export function idempotencyPrincipalFor(ctx: AuthorizationContext): string {
  return formatIdempotencyPrincipal(ctx.principal.kind, ctx.principal.id);
}

// ---------------------------------------------------------------------------
// Actors, resources and audiences
// ---------------------------------------------------------------------------

export const ACTOR_KIND_VALUES = ["user", "service"] as const;
export const actorKindSchema = z.enum(ACTOR_KIND_VALUES);
export const actorRefSchema = z
  .object({ kind: actorKindSchema, id: opaqueIdSchema })
  .strict();

// The resource vocabulary the receipt target union and Grant share.
export const RESOURCE_KIND_VALUES = [
  "workspace",
  "session",
  "invite",
  "agent",
  "agent_release",
  "surface_binding",
  "session_link",
  "dispatch",
  "memory",
  "routine",
  "artifact",
] as const;
export const resourceKindSchema = z.enum(RESOURCE_KIND_VALUES);
export const resourceRefSchema = z
  .object({ kind: resourceKindSchema, id: z.string().min(1).max(512) })
  .strict();

export const AUDIENCE_KIND_VALUES = [
  "workspace",
  "surface_binding",
  "session_link",
  "session",
] as const;
export const audienceKindSchema = z.enum(AUDIENCE_KIND_VALUES);
export const audienceRefSchema = z
  .object({ kind: audienceKindSchema, id: z.string().min(1).max(512) })
  .strict();

export const AUTHORIZATION_ACTION_VALUES = [
  "workspace.read",
  "workspace.manage",
  "agent.manage",
  "binding.manage",
  "routine.manage",
  "session.read",
  "session.submit",
  "session.approve",
  "session.control",
  "session.recover",
  "memory.read",
  "memory.write",
  "artifact.read",
  "delivery.send",
] as const;
export const authorizationActionSchema = z.enum(AUTHORIZATION_ACTION_VALUES);

export type ActorRef = z.infer<typeof actorRefSchema>;
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export type AudienceRef = z.infer<typeof audienceRefSchema>;
export type AuthorizationAction = z.infer<typeof authorizationActionSchema>;

// Ported from Kollegium `core/src/schema.ts`: an action can only ever be
// granted on a resource type it makes sense for, so a `session.read` grant
// cannot be widened into workspace-wide reads by swapping the resource.
const ACTION_RESOURCE_KINDS: Record<
  AuthorizationAction,
  ReadonlySet<ResourceKind>
> = {
  "workspace.read": new Set(["workspace"]),
  "workspace.manage": new Set(["workspace"]),
  "agent.manage": new Set(["workspace", "agent"]),
  "binding.manage": new Set(["workspace", "agent", "surface_binding"]),
  "routine.manage": new Set(["workspace", "agent", "routine"]),
  "session.read": new Set(["session", "session_link"]),
  "session.submit": new Set(["session", "session_link", "surface_binding"]),
  "session.approve": new Set(["session", "session_link"]),
  "session.control": new Set(["session", "session_link"]),
  "session.recover": new Set(["session"]),
  "memory.read": new Set(["workspace", "agent", "memory"]),
  "memory.write": new Set(["workspace", "agent", "memory"]),
  "artifact.read": new Set(["artifact", "session"]),
  "delivery.send": new Set(["session", "session_link", "surface_binding"]),
};

// ---------------------------------------------------------------------------
// Grant
// ---------------------------------------------------------------------------

export const grantSchema = z
  .object({
    grant_id: grantIdSchema,
    workspace_id: workspaceIdSchema,
    actor: actorRefSchema,
    /** The installation or app acting for the actor; null for direct use. */
    service_principal: actorRefSchema.nullable(),
    actions: z.array(authorizationActionSchema).min(1),
    resource: resourceRefSchema,
    audience: audienceRefSchema,
    /** Never widens the 94S-132 key scope; it can only narrow it. */
    scopes: z.array(sessionScopeSchema),
    revision: revisionSchema,
    revoked_at: timestampSchema.nullable(),
    expires_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((grant, ctx) => {
    for (const action of grant.actions) {
      if (!ACTION_RESOURCE_KINDS[action].has(grant.resource.kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["actions"],
          message: `${action} cannot grant access to ${grant.resource.kind}`,
        });
      }
    }
  });

export type Grant = z.infer<typeof grantSchema>;

export type GrantRequest = {
  /** The workspace the resource lives in; a grant never crosses it. */
  workspaceId: string;
  actor: ActorRef;
  servicePrincipal: ActorRef | null;
  action: AuthorizationAction;
  resource: ResourceRef;
  audience: AudienceRef;
};

// An action that touches a session also needs the 94S-132 scope for it, so a
// grant listing `session.control` while holding only `sessions:read` is inert.
// Workspace, agent, memory and delivery actions have no session scope to spend.
const ACTION_SESSION_SCOPE: Record<AuthorizationAction, SessionScope | null> = {
  "workspace.read": null,
  "workspace.manage": null,
  "agent.manage": null,
  "binding.manage": null,
  "routine.manage": null,
  "session.read": "sessions:read",
  "session.submit": "sessions:write",
  "session.approve": "sessions:approve",
  "session.control": "sessions:control",
  "session.recover": "sessions:recover",
  "memory.read": null,
  "memory.write": null,
  "artifact.read": "sessions:read",
  "delivery.send": null,
};

function sameRef(
  left: { kind: string; id: string } | null,
  right: { kind: string; id: string } | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.id === right.id;
}

// Both timestamps are RFC 3339 but need not share fractional precision, and
// `"…:00.500Z" < "…:00Z"` is true as a string. Compare instants instead.
// Date.parse truncates below the millisecond; two grants that differ only in
// microseconds are the same instant here, which is finer than any expiry the
// platform issues.
function instant(timestamp: string): number {
  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) {
    throw new TypeError(`not an RFC 3339 timestamp: ${timestamp}`);
  }
  return value;
}

/** Revocation and expiry both take effect at the instant they name. */
export function isGrantActive(grant: Grant, at: string): boolean {
  const now = instant(at);
  if (grant.revoked_at !== null && instant(grant.revoked_at) <= now) {
    return false;
  }
  return grant.expires_at === null || now < instant(grant.expires_at);
}

/**
 * Exact match only — no wildcards, no role inheritance, no prefix rules. A
 * caller checks this before loading the resource so a deny cannot leak the
 * resource's existence (03b §4.1).
 */
export function grantCovers(
  grant: Grant,
  request: GrantRequest,
  at: string,
): boolean {
  if (!isGrantActive(grant, at)) return false;
  if (grant.workspace_id !== request.workspaceId) return false;
  if (!sameRef(grant.actor, request.actor)) return false;
  if (!sameRef(grant.service_principal, request.servicePrincipal)) return false;
  if (!grant.actions.includes(request.action)) return false;
  const required = ACTION_SESSION_SCOPE[request.action];
  if (required !== null && !grant.scopes.includes(required)) return false;
  if (!sameRef(grant.resource, request.resource)) return false;
  return sameRef(grant.audience, request.audience);
}

// ---------------------------------------------------------------------------
// Actor provenance (Codex B19)
// ---------------------------------------------------------------------------

/** What `receipts.actor` stores: the principal plus the human behind it. */
export const receiptActorSchema = z
  .object({
    principal: principalRefSchema,
    actor_user_id: userIdSchema.nullable(),
    agent_id: agentIdSchema.nullable(),
  })
  .strict();

/** The `turns.actor_id` column: the human whose input started the turn. */
export const turnActorIdSchema = userIdSchema.nullable();

export type ReceiptActor = z.infer<typeof receiptActorSchema>;
