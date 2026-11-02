import type { ListSessionAchievementsResponse } from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../../musterrolle/policy.ts";
import { requirePermitted, SessionServiceError } from "../session-service.ts";
import type { AchievementJudgmentStore } from "./achievement-judgment-store.ts";

/** A session's achievements and its latest judgment; reads only. */
export function createSessionAchievementService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<AchievementJudgmentStore, "list">;
}) {
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
  };
}

export type SessionAchievementService = ReturnType<
  typeof createSessionAchievementService
>;
