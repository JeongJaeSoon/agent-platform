export type Principal = { ownerId: string };
export type SessionAction =
  | "sessions:read"
  | "sessions:write"
  | "sessions:control"
  | "sessions:approve"
  // Operator recovery decisions. api.md § 최소 운영 복구: issued apart from
  // ordinary keys; a policy that knows scopes (94S-132) denies it to a
  // key that owns the session but was not given it.
  | "sessions:recover";

export interface AuthorizationPolicy {
  authorize(
    actor: Principal,
    action: SessionAction,
    resource: { ownerId: string },
  ): boolean;
}

// Owner match only; scopes per API key arrive with 94S-132.
export const ownerScopedPolicy: AuthorizationPolicy = {
  authorize(actor, _action, resource) {
    return actor.ownerId === resource.ownerId;
  },
};
