import type {
  ControlAcceptedResponse,
  InterruptSessionRequest,
} from "@agent-platform/contracts";
import type {
  AuthorizationPolicy,
  Principal,
} from "../authorization/policy.ts";
import type { TurnInterrupts } from "../ports/turn-interrupts.ts";
import { payloadHash, SessionServiceError } from "./session-service.ts";

export function createInterruptService(deps: {
  authorization: AuthorizationPolicy;
  store: TurnInterrupts;
}) {
  const { authorization, store } = deps;

  return {
    async interrupt(
      actor: Principal,
      sessionId: string,
      input: { idempotencyKey: string; body: InterruptSessionRequest },
    ): Promise<ControlAcceptedResponse> {
      if (
        !authorization.authorize(actor, "sessions:control", {
          ownerId: actor.ownerId,
        })
      ) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      const result = await store.interruptAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        targetTurnId: input.body.target_turn_id,
      });
      switch (result.outcome) {
        case "conflict":
          throw new SessionServiceError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different payload",
          );
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "not_started":
          throw new SessionServiceError(
            "TURN_NOT_STARTED",
            "The turn is still queued; only a running turn can be interrupted",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be interrupted",
          );
        default:
          return result.response;
      }
    },
  };
}

export type InterruptService = ReturnType<typeof createInterruptService>;
