import {
  type ListTakeoversResponse,
  TAKEOVER_LIST_LIMIT,
  type TakeOverSessionResponse,
} from "@agent-platform/contracts";
import type { MemberStore, OffboardResult } from "../ports/member-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";

// Offboarding and takeover (design D16), both member.manage. The resource
// is the caller's own workspace: there is no other a caller can name.
export function createMemberService(deps: {
  authorization: AuthorizationPolicy;
  store: MemberStore;
}) {
  const { authorization, store } = deps;

  function personOf(caller: Caller): string {
    const userId = caller.actor?.userId;
    // member.manage is held by users only, so an allowed caller has one.
    if (!userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "This principal does not hold member.manage",
      );
    }
    return userId;
  }

  return {
    async offboardMember(
      caller: Caller,
      userId: string,
    ): Promise<Extract<OffboardResult, { outcome: "offboarded" }>> {
      await requirePermitted(authorization, caller, "member.manage", {
        kind: "workspace",
        id: caller.ownerId,
      });
      // Offboarding yourself would leave a workspace whose last owner is
      // locked out, with nobody left to undo it.
      if (personOf(caller) === userId.toLowerCase()) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "A member cannot offboard themselves",
        );
      }
      const result = await store.offboard({
        workspaceId: caller.ownerId,
        userId,
      });
      if (result.outcome === "not_found") {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return result;
    },

    async listTakeovers(caller: Caller): Promise<ListTakeoversResponse> {
      await requirePermitted(authorization, caller, "member.manage", {
        kind: "workspace",
        id: caller.ownerId,
      });
      const rows = await store.listAwaitingTakeover(
        caller.ownerId,
        TAKEOVER_LIST_LIMIT,
      );
      return {
        items: rows.map((row) => ({
          session_id: row.sessionId,
          departed_user_id: row.departedUserId,
          status: row.status,
          created_at: row.createdAt.toISOString(),
          takeover_required_at: row.takeoverRequiredAt.toISOString(),
        })),
      };
    },

    async takeOverSession(
      caller: Caller,
      sessionId: string,
    ): Promise<TakeOverSessionResponse> {
      await requirePermitted(authorization, caller, "member.manage", {
        kind: "session",
        id: sessionId,
      });
      const result = await store.takeOver({
        principal: caller,
        workspaceId: caller.ownerId,
        sessionId,
        newRequesterId: personOf(caller),
      });
      switch (result.outcome) {
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "not_awaiting":
          throw new SessionServiceError(
            "REQUEST_STALE",
            "Session is not awaiting a takeover",
          );
        default:
          return { receipt_id: result.receiptId, receipt_status: "succeeded" };
      }
    },
  };
}

export type MemberService = ReturnType<typeof createMemberService>;
