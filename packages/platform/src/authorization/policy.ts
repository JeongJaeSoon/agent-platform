export type Principal = { ownerId: string };
export type SessionAction =
  | "sessions:read"
  | "sessions:write"
  | "sessions:control"
  | "sessions:approve"
  // Operator recovery decisions. api.md § 최소 운영 복구: issued apart from
  // ordinary keys.
  | "sessions:recover";

export interface AuthorizationPolicy {
  authorize(
    actor: Principal,
    action: SessionAction,
    resource: { ownerId: string },
  ): boolean;
}

// Owner match only. Scopes are checked at the HTTP edge before a service is
// called (apps/control-host/src/api/scope-policy.ts, 94S-132); this policy is where they
// move once something other than the API calls these services.
export const ownerScopedPolicy: AuthorizationPolicy = {
  authorize(actor, _action, resource) {
    return actor.ownerId === resource.ownerId;
  },
};
