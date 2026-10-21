import type {
  ListPendingRequestsResponse,
  PostSessionAnswerRequest,
  PostSessionAnswerResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type { PendingRequestStore } from "../ports/pending-requests.ts";
import {
  idempotencyConflict,
  payloadHash,
  requireAllowed,
  requirePermitted,
  SessionServiceError,
} from "./session-service.ts";

// api.md § 승인·중단·강제 종료. Kept apart from the session service so the
// answer path owns its own error vocabulary: REQUEST_EXPIRED and
// REQUEST_STALE mean nothing to any other session command.
export function createPendingRequestService(deps: {
  authorization: AuthorizationPolicy;
  store: PendingRequestStore;
}) {
  const { authorization, store } = deps;

  return {
    async listPendingRequests(
      actor: Caller,
      sessionId: string,
    ): Promise<ListPendingRequestsResponse> {
      await requirePermitted(authorization, actor, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const items = await store.listOpen(actor.ownerId, sessionId);
      if (items === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return { items };
    },

    async answer(
      actor: Caller,
      sessionId: string,
      input: { idempotencyKey: string; body: PostSessionAnswerRequest },
    ): Promise<PostSessionAnswerResponse> {
      const decision = await requireAllowed(
        authorization,
        actor,
        "session.approve",
        { kind: "session", id: sessionId },
      );
      const result = await store.answerAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        answer: input.body,
        approval: {
          surface: actor.subject.surface.kind,
          decisionId: decision.decision_id,
        },
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
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
