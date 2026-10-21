import {
  type AuthorizationSubject,
  SESSION_SCOPE_VALUES,
  type SessionScope,
} from "@agent-platform/contracts";

/**
 * A service caller authenticated the way AUTH_MODE=none authenticates: a
 * legacy API key named by its owner partition, holding `scopes`.
 */
export function testCaller(
  ownerId: string,
  scopes: readonly SessionScope[] = SESSION_SCOPE_VALUES,
): { ownerId: string; subject: AuthorizationSubject; requestId: string } {
  return {
    ownerId,
    subject: {
      principal: {
        kind: "api_key",
        id: ownerId,
        owner_id: ownerId,
        workspace_id: null,
        scopes: [...scopes],
      },
      surface: { kind: "api" },
    },
    requestId: crypto.randomUUID(),
  };
}
