import { z } from "zod";

import {
  agentIdSchema,
  grantIdSchema,
  installationIdSchema,
  opaqueIdSchema,
  ownerScopeSchema,
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

/**
 * The scopes in `held` that `ceiling` does not allow. Every schema that
 * carries a scope list next to the thing that bounds it — a role, a
 * principal — checks itself with this, so no response can describe an
 * authority its own ceiling refuses.
 */
export function scopesExceeding(
  held: readonly SessionScope[],
  ceiling: readonly SessionScope[],
): SessionScope[] {
  const allowed = new Set(ceiling);
  return held.filter((scope) => !allowed.has(scope));
}

// ---------------------------------------------------------------------------
// Principal and authorization context
// ---------------------------------------------------------------------------

export const PRINCIPAL_KIND_VALUES = [
  "api_key",
  "user",
  "installation",
] as const;
export const principalKindSchema = z.enum(PRINCIPAL_KIND_VALUES);

/**
 * A chat installation's ceiling. Recovery is an operator power (03b §4.1
 * "복구 | sessions:recover | operator 권한") and a chat app is not an
 * operator, so it is not in the vocabulary an installation can even name.
 */
export const INSTALLATION_SESSION_SCOPE_VALUES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
] as const;
export const installationSessionScopeSchema = z.enum(
  INSTALLATION_SESSION_SCOPE_VALUES,
);

/**
 * Just enough to name who is acting; the full principal carries the ceiling.
 * The id is uncapped because each kind mints its own: a legacy api key is
 * named by the owner partition, which is unconstrained `text`. A ref narrower
 * than the thing it names would reject an existing tenant outright.
 */
export const principalRefSchema = z
  .object({ kind: principalKindSchema, id: z.string().min(1) })
  .strict();

export const ACTOR_KIND_VALUES = ["user", "service"] as const;
export const actorKindSchema = z.enum(ACTOR_KIND_VALUES);
export const actorRefSchema = z
  .object({ kind: actorKindSchema, id: opaqueIdSchema })
  .strict();
// Where a field means one or the other and swapping them would move
// authority, name which one it is rather than accept either.
export const humanActorSchema = actorRefSchema.extend({
  kind: z.literal("user"),
});
export const serviceActorSchema = actorRefSchema.extend({
  kind: z.literal("service"),
});

export const principalSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("api_key"),
        id: opaqueIdSchema,
        owner_id: ownerScopeSchema,
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
    // A signed chat webhook carries no bearer key, so what authenticated is
    // the installation, not the person who typed (03b §4.1). The human stays
    // the actor: the app's authority is never inherited by them, and theirs is
    // never lent to the app. A Slack user with no internal mapping still
    // produces a representable context — it simply has no `actor_user_id`, and
    // admission fails on identity rather than on a malformed principal.
    z
      .object({
        kind: z.literal("installation"),
        id: installationIdSchema,
        /** The workspace's server-issued service owner, never the chat team id. */
        owner_id: ownerScopeSchema,
        workspace_id: workspaceIdSchema,
        scopes: z.array(installationSessionScopeSchema),
      })
      .strict(),
  ])
  .superRefine((principal, ctx) => {
    if (principal.kind !== "user") return;
    // The role is the ceiling, not a label beside it: a membership may hand a
    // user fewer scopes than the role allows, never more. Without this a
    // `member` row carrying `sessions:recover` would walk straight into
    // owner-only recovery.
    for (const scope of scopesExceeding(
      principal.scopes,
      scopesForRole(principal.role),
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: `${principal.role} cannot hold ${scope}`,
      });
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
    /**
     * The installation or app carrying the request. It lends no authority of
     * its own; a grant match compares it, so a context assembled without it
     * cannot ask about a grant that names one (03b §4.1).
     */
    service_principal: serviceActorSchema.optional(),
    owner_scope: ownerScopeSchema,
    workspace_id: workspaceIdSchema.optional(),
    /** The 94S-132 ceiling carried with the context, never re-derived downstream. */
    scopes: z.array(sessionScopeSchema),
  })
  .strict()
  .superRefine((ctx_, ctx) => {
    // Middleware assembles a context by hand, so the relationships between
    // its parts are stated here. What a schema cannot check is whether the
    // user really belongs to that workspace or whether the scopes match their
    // role — the context carries no role, and membership is a row (94S-150,
    // 94S-152). It can check that the parts agree with each other, which is
    // what stops a hand-built context from authorizing against another
    // tenant's partition.
    if (ctx_.principal.kind === "installation") {
      // What this cannot reach: whether `owner_scope` and `workspace_id` are
      // the ones the authenticated installation actually belongs to. Unlike a
      // user — whose partition IS its workspace, so the two must agree — an
      // installation's owner is a separate service owner, and no relation
      // between the three is checkable from the context alone. Closing it
      // means carrying the whole principal here instead of a ref, which is a
      // different contract from the one this card fixed; 94S-152 owns it.
      //
      // What authenticated is also what acts for the human, so a context
      // claiming installation A must not match grants naming service B.
      if (ctx_.service_principal?.id !== ctx_.principal.id) {
        ctx.addIssue({
          code: "custom",
          path: ["service_principal"],
          message: "an installation is its own service principal",
        });
      }
      if (ctx_.workspace_id === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace_id"],
          message: "an installation always has a workspace",
        });
      }
      // The context's `scopes` is the general vocabulary, so the ceiling
      // `principalSchema` puts on an installation has to be repeated where a
      // context is validated directly — otherwise middleware hands a chat app
      // operator-only recovery and nothing objects.
      for (const scope of scopesExceeding(
        ctx_.scopes,
        INSTALLATION_SESSION_SCOPE_VALUES,
      )) {
        ctx.addIssue({
          code: "custom",
          path: ["scopes"],
          message: `an installation cannot hold ${scope}`,
        });
      }
      return;
    }
    if (ctx_.principal.kind !== "user") return;
    if (ctx_.actor_user_id !== ctx_.principal.id) {
      ctx.addIssue({
        code: "custom",
        path: ["actor_user_id"],
        message: "a user principal acts as itself",
      });
    }
    if (ctx_.workspace_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["workspace_id"],
        message: "a user principal always has a workspace",
      });
      return;
    }
    if (ctx_.owner_scope !== ctx_.workspace_id) {
      ctx.addIssue({
        code: "custom",
        path: ["owner_scope"],
        message: "a user's owner partition is their workspace",
      });
    }
  });

export type PrincipalKind = z.infer<typeof principalKindSchema>;
export type PrincipalRef = z.infer<typeof principalRefSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type AuthorizationContext = z.infer<typeof authorizationContextSchema>;

// ---------------------------------------------------------------------------
// Actors, resources and audiences
// ---------------------------------------------------------------------------

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
export type HumanActor = z.infer<typeof humanActorSchema>;
export type ServiceActor = z.infer<typeof serviceActorSchema>;
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
    service_principal: serviceActorSchema.nullable(),
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
    // A grant stored under workspace A must not name workspace B as what it
    // covers: a grant match compares the request's workspace against
    // `workspace_id`, so an inconsistent row plus a request carrying those
    // same B references would otherwise match across the boundary.
    for (const field of ["resource", "audience"] as const) {
      const ref = grant[field];
      if (ref.kind === "workspace" && ref.id !== grant.workspace_id) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "a grant cannot name another workspace",
        });
      }
    }
  });

export type Grant = z.infer<typeof grantSchema>;

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
  .strict()
  .superRefine((actor, ctx) => {
    // A receipt is the audit record. A user principal acting as itself is
    // what the context already enforces; a receipt saying otherwise would be
    // provenance that contradicts the request it describes.
    if (
      actor.principal.kind === "user" &&
      actor.actor_user_id !== actor.principal.id
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["actor_user_id"],
        message: "a user principal acts as itself",
      });
    }
  });

/** The `turns.actor_id` column: the human whose input started the turn. */
export const turnActorIdSchema = userIdSchema.nullable();

export type ReceiptActor = z.infer<typeof receiptActorSchema>;
