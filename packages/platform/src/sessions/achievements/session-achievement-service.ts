import type {
  ListSessionAchievementsResponse,
  RejudgeSessionResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../../musterrolle/policy.ts";
import { NOT_FOUND, OUTRANKED } from "../../musterrolle/service-errors.ts";
import { requirePermitted, SessionServiceError } from "../session-service.ts";
import type { AchievementJudgmentStore } from "./achievement-judgment-store.ts";

/** A session's achievements and its latest judgment, and its manual rejudge. */
export function createSessionAchievementService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<AchievementJudgmentStore, "list" | "rejudge">;
  newId?: () => string;
}) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  return {
    async list(
      caller: Caller,
      rawSessionId: string,
    ): Promise<ListSessionAchievementsResponse> {
      const sessionId = rawSessionId.toLowerCase();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const listed = await deps.store.list(caller.ownerId, sessionId);
      if (listed === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return listed;
    },

    /** Owners and admins who can read the session; a person, never a key. */
    async rejudge(
      caller: Caller,
      rawSessionId: string,
    ): Promise<RejudgeSessionResponse> {
      const sessionId = rawSessionId.toLowerCase();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      await requirePermitted(
        deps.authorization,
        caller,
        "achievement_rule.manage",
        { kind: "workspace", id: caller.ownerId },
      );
      const userId = caller.actor?.userId;
      const workspaceId = caller.actor?.workspaceId;
      if (
        caller.subject.principal?.kind !== "user" ||
        !userId ||
        !workspaceId
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "Only a signed-in person rejudges a session",
          undefined,
          { reason_code: "role" },
        );
      }
      const receiptId = newId();
      const result = await deps.store.rejudge({
        actor: { principal: caller, workspaceId, userId },
        sessionId,
        receiptId,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "not_found":
          throw NOT_FOUND();
        default:
          return { judgment_id: result.judgmentId, receipt_id: receiptId };
      }
    },
  };
}

export type SessionAchievementService = ReturnType<
  typeof createSessionAchievementService
>;
