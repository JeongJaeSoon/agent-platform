export type Principal = { ownerId: string };
export type SessionAction = "sessions:read" | "sessions:write";

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
