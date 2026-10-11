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
  type PrincipalRef,
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@agent-platform/contracts";
import type { DecisionLog } from "../ports/decision-log.ts";

export type RecordedActor = {
  principal: PrincipalRef;
  userId: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
};

/** The partition a store reads and writes under. */
export type Principal = {
  ownerId: string;
  actor?: RecordedActor;
  requestId?: string;
};

/**
 * Who calls a service. `ownerId` is what the stores partition on; the policy
 * checks it against the subject, so a caller assembled with another owner's
 * partition is told the resource does not exist.
 */
export type Caller = Principal & {
  subject: AuthorizationSubject;
  requestId: string;
};

/**
 * `storedKey` is set only when authentication found the key's row: the
 * AUTH_MODE=none principal is an api_key named after its owner, with no row.
 */
export function callerFor(
  principal: AuthenticatedPrincipal,
  surface: AuthorizationSurface,
  requestId: string,
  storedKey?: { creatorId: string | null },
): Caller {
  const userId =
    principal.kind === "user"
      ? principal.id
      : principal.kind === "api_key"
        ? (storedKey?.creatorId ?? null)
        : null;
  return {
    ownerId: ownerScopeOf(principal),
    actor: {
      principal: { kind: principal.kind, id: principal.id },
      userId,
      workspaceId: principal.workspace_id,
      apiKeyId: principal.kind === "api_key" && storedKey ? principal.id : null,
    },
    subject: {
      principal,
      ...(userId === null ? {} : { actor_user_id: userId }),
      surface,
    },
    requestId,
  };
}

export type IdentityReading =
  | {
      status: "ok";
      principal: AuthenticatedPrincipal;
      keyCreator?: { userId: string; role: WorkspaceRole };
    }
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

// An installation names no person until linked accounts exist, so it is
// unlinked.
export const authenticatedIdentity: IdentityReader = {
  async reread(subject) {
    return subject.principal.kind === "installation"
      ? { status: "unlinked" }
      : { status: "ok", principal: subject.principal };
  },
};

export const POLICY_VERSION = "m2";

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

export const MANAGEMENT_ROLES: Partial<
  Record<AuthorizationAction, readonly WorkspaceRole[]>
> = {
  "workspace.manage": ["owner"],
  "member.manage": ["owner"],
  "api_key.manage": ["owner"],
  "api_key.manage_own": ["owner", "member"],
  "agent.manage": ["owner"],
  "binding.manage": ["owner"],
};

function within(
  scopes: readonly SessionScope[],
  role: WorkspaceRole,
): SessionScope[] {
  const ceiling = new Set(scopesForRole(role));
  return scopes.filter((scope) => ceiling.has(scope));
}

function authorityScopes(reading: {
  principal: AuthenticatedPrincipal;
  keyCreator?: { role: WorkspaceRole };
}): SessionScope[] {
  const { principal, keyCreator } = reading;
  if (principal.kind === "user")
    return within(principal.scopes, principal.role);
  if (keyCreator) return within(principal.scopes, keyCreator.role);
  return [...principal.scopes];
}

function claimedActorMatches(
  subject: AuthorizationSubject,
  reading: Extract<IdentityReading, { status: "ok" }>,
): boolean {
  const expected =
    reading.principal.kind === "user"
      ? reading.principal.id
      : reading.keyCreator?.userId;
  return subject.actor_user_id === expected;
}

export const RECORDED_ALLOW_ACTIONS: ReadonlySet<AuthorizationAction> = new Set(
  [
    "workspace.manage",
    "member.manage",
    "api_key.manage",
    "api_key.manage_own",
    "agent.manage",
    "binding.manage",
    "routine.manage",
    "session.approve",
  ],
);

export function mustRecord(
  request: AuthorizationRequest,
  decision: AuthorizationDecision,
): boolean {
  return (
    decision.outcome !== "allow" ||
    RECORDED_ALLOW_ACTIONS.has(request.action) ||
    (request.subject.surface.kind === "slack" &&
      request.action === "session.submit")
  );
}

export function createAuthorizationPolicy(
  deps: {
    identity?: IdentityReader;
    newDecisionId?: () => string;
    decisions?: DecisionLog;
  } = {},
): AuthorizationPolicy {
  const identity = deps.identity ?? authenticatedIdentity;
  const decisions = deps.decisions;
  const newDecisionId = deps.newDecisionId ?? (() => crypto.randomUUID());

  async function decide(
    request: AuthorizationRequest,
  ): Promise<[AuthorizationReason, SessionScope[]]> {
    const parsed = authorizationRequestSchema.safeParse(request);
    if (!parsed.success) return ["error", []];
    const { subject, action, resource } = parsed.data;
    const scope = ACTION_SCOPES[action];
    const roles = MANAGEMENT_ROLES[action];
    if (
      (scope === undefined && roles === undefined) ||
      !actionAppliesTo(action, resource.kind)
    ) {
      return ["error", []];
    }
    if (subject.principal === null) return ["no_requester", []];

    const reading = await identity.reread({
      ...subject,
      principal: subject.principal,
    });
    if (reading.status !== "ok") return [reading.status, []];
    if (!claimedActorMatches(subject, reading)) return ["error", []];
    if (resource.owner_scope !== ownerScopeOf(reading.principal)) {
      return ["not_found", []];
    }

    const scopes = authorityScopes(reading);
    if (roles !== undefined) {
      const { principal } = reading;
      if (principal.kind !== "user" || !roles.includes(principal.role)) {
        return ["role", scopes];
      }
    } else if (scope === undefined || !scopes.includes(scope)) {
      return ["role", scopes];
    }
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
      const decision: AuthorizationDecision = {
        outcome: reason === "ok" ? "allow" : "deny",
        reason_code: reason,
        effective_scopes,
        policy_version: POLICY_VERSION,
        decision_id,
      };
      const parsed = authorizationRequestSchema.safeParse(request);
      if (!decisions || !parsed.success || !mustRecord(parsed.data, decision)) {
        return decision;
      }
      try {
        await decisions.record({ request: parsed.data, decision });
        return decision;
      } catch {
        if (decision.outcome !== "allow") return decision;
        return {
          ...decision,
          outcome: "deny",
          reason_code: "error",
          effective_scopes: [],
        };
      }
    },
  };
}
