import {
  type Principal as AuthenticatedPrincipal,
  type AuthorizationAction,
  type AuthorizationDecision,
  type AuthorizationReason,
  type AuthorizationRequest,
  type AuthorizationSubject,
  type AuthorizationSurface,
  actionAppliesTo,
  authorizationRequestSchema,
  ownerScopeOf,
  type SessionScope,
  scopesForRole,
} from "@agent-platform/contracts";

/** The partition a store reads and writes under. */
export type Principal = { ownerId: string };

/**
 * Who calls a service. `ownerId` is what the stores partition on; the policy
 * checks it against the subject, so a caller assembled with another owner's
 * partition is told the resource does not exist.
 */
export type Caller = Principal & {
  subject: AuthorizationSubject;
  requestId: string;
};

export function callerFor(
  principal: AuthenticatedPrincipal,
  surface: AuthorizationSurface,
  requestId: string,
): Caller {
  return {
    ownerId: ownerScopeOf(principal),
    subject: {
      principal,
      ...(principal.kind === "user" ? { actor_user_id: principal.id } : {}),
      surface,
    },
    requestId,
  };
}

export type IdentityReading =
  | { status: "ok"; principal: AuthenticatedPrincipal }
  | {
      status: Extract<
        AuthorizationReason,
        "unlinked" | "disabled" | "stale_link"
      >;
    };

// Step 1 of the decision: the identity as it stands now, read for every
// decision and never cached across requests.
export interface IdentityReader {
  reread(
    subject: AuthorizationSubject & { principal: AuthenticatedPrincipal },
  ): Promise<IdentityReading>;
}

// Nothing to re-read yet: users, memberships and keys are read at
// authentication within the same request. An installation names no person
// until linked accounts exist, so it is unlinked.
export const authenticatedIdentity: IdentityReader = {
  async reread(subject) {
    return subject.principal.kind === "installation"
      ? { status: "unlinked" }
      : { status: "ok", principal: subject.principal };
  },
};

export const POLICY_VERSION = "m1";

export interface AuthorizationPolicy {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

// The scope each session action needs. Actions with no scope have no rule
// yet and are refused.
export const ACTION_SCOPES: Partial<Record<AuthorizationAction, SessionScope>> =
  {
    "session.read": "sessions:read",
    "session.submit": "sessions:write",
    "session.approve": "sessions:approve",
    "session.control": "sessions:control",
    "session.recover": "sessions:recover",
  };

function authorityScopes(principal: AuthenticatedPrincipal): SessionScope[] {
  if (principal.kind !== "user") return [...principal.scopes];
  const ceiling = new Set(scopesForRole(principal.role));
  return principal.scopes.filter((scope) => ceiling.has(scope));
}

export function createAuthorizationPolicy(
  deps: { identity?: IdentityReader; newDecisionId?: () => string } = {},
): AuthorizationPolicy {
  const identity = deps.identity ?? authenticatedIdentity;
  const newDecisionId = deps.newDecisionId ?? (() => crypto.randomUUID());

  async function decide(
    request: AuthorizationRequest,
  ): Promise<[AuthorizationReason, SessionScope[]]> {
    const parsed = authorizationRequestSchema.safeParse(request);
    if (!parsed.success) return ["error", []];
    const { subject, action, resource } = parsed.data;
    const scope = ACTION_SCOPES[action];
    if (scope === undefined || !actionAppliesTo(action, resource.kind)) {
      return ["error", []];
    }
    if (subject.principal === null) return ["no_requester", []];

    const reading = await identity.reread({
      ...subject,
      principal: subject.principal,
    });
    if (reading.status !== "ok") return [reading.status, []];
    if (resource.owner_scope !== ownerScopeOf(reading.principal)) {
      return ["not_found", []];
    }

    const scopes = authorityScopes(reading.principal);
    if (!scopes.includes(scope)) return ["role", scopes];
    // Slack's ceiling is the binding's allowed actions, which have no table
    // yet; web and api add no ceiling of their own.
    if (subject.surface.kind === "slack") return ["surface_ceiling", scopes];
    // No agent identity has a ceiling to multiply by yet.
    if (subject.agent !== undefined) return ["agent_ceiling", scopes];
    return ["ok", scopes];
  }

  return {
    async authorize(request) {
      const decision_id = newDecisionId();
      let reason: AuthorizationReason;
      let effective_scopes: SessionScope[];
      try {
        [reason, effective_scopes] = await decide(request);
      } catch {
        [reason, effective_scopes] = ["error", []];
      }
      return {
        outcome: reason === "ok" ? "allow" : "deny",
        reason_code: reason,
        effective_scopes,
        policy_version: POLICY_VERSION,
        decision_id,
      };
    },
  };
}
