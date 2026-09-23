import type {
  ListPendingRequestsResponse,
  PostSessionAnswerRequest,
  PostSessionAnswerResponse,
} from "@agent-platform/contracts";
import type {
  AuthorizationPolicy,
  Principal,
} from "../authorization/policy.ts";
import type { PendingRequestStore } from "../ports/pending-requests.ts";
import { payloadHash, SessionServiceError } from "./session-service.ts";

// api.md § 승인·중단·강제 종료. Kept apart from the session service so the
// answer path owns its own error vocabulary: REQUEST_EXPIRED and
// REQUEST_STALE mean nothing to any other session command.
export function createPendingRequestService(deps: {
  authorization: AuthorizationPolicy;
  store: PendingRequestStore;
}) {
  const { authorization, store } = deps;

  function requireAuthorized(
    actor: Principal,
    action: "sessions:read" | "sessions:approve",
  ) {
    if (!authorization.authorize(actor, action, { ownerId: actor.ownerId })) {
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
  }

  return {
    async listPendingRequests(
      actor: Principal,
      sessionId: string,
    ): Promise<ListPendingRequestsResponse> {
      requireAuthorized(actor, "sessions:read");
      const items = await store.listOpen(actor.ownerId, sessionId);
      if (items === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return { items };
    },

    async answer(
      actor: Principal,
      sessionId: string,
      input: { idempotencyKey: string; body: PostSessionAnswerRequest },
    ): Promise<PostSessionAnswerResponse> {
      requireAuthorized(actor, "sessions:approve");
      const result = await store.answerAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        answer: input.body,
      });
      switch (result.outcome) {
        case "conflict":
          throw new SessionServiceError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different payload",
          );
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "expired":
          throw new SessionServiceError(
            "REQUEST_EXPIRED",
            "The request is already answered, expired or closed",
          );
        case "stale":
          throw new SessionServiceError(
            "REQUEST_STALE",
            "The attempt that asked no longer owns the session",
          );
        case "invalid":
          throw new SessionServiceError("BAD_REQUEST", result.reason);
        default:
          return result.response;
      }
    },
  };
}

export type PendingRequestService = ReturnType<
  typeof createPendingRequestService
>;
