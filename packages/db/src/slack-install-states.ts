import type { SlackInstallStore } from "@werft-ai/platform";
import { eq, lt } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { slackInstallStates } from "./schema.ts";
import {
  registerSlackInstallation,
  verifySlackInstallation,
} from "./slack-installations.ts";

export function createPostgresSlackInstallStore(
  db: Database,
): SlackInstallStore {
  return {
    async issueState(stateHash, state, now) {
      await db
        .delete(slackInstallStates)
        .where(lt(slackInstallStates.expiresAt, now));
      await db.insert(slackInstallStates).values({
        stateHash,
        workspaceId: state.workspaceId,
        agentId: state.agentId,
        slackAppId: state.slackAppId,
        actorUserId: state.actorUserId,
        teamId: state.teamId,
        redirectUrl: state.redirectUrl,
        expiresAt: state.expiresAt,
      });
    },

    async consumeState(stateHash) {
      // One DELETE: of two requests with the same state, one gets the row.
      const [row] = await db
        .delete(slackInstallStates)
        .where(eq(slackInstallStates.stateHash, stateHash))
        .returning();
      if (!row) return null;
      return {
        workspaceId: row.workspaceId,
        agentId: row.agentId,
        slackAppId: row.slackAppId,
        actorUserId: row.actorUserId,
        teamId: row.teamId,
        redirectUrl: row.redirectUrl,
        expiresAt: row.expiresAt,
      };
    },

    async recordInstallation(input) {
      const key = { appId: input.appId, teamId: input.teamId };
      const registered = await registerSlackInstallation(db, {
        ...key,
        workspaceId: input.workspaceId,
      });
      if (registered.outcome === "workspace_conflict") {
        return { outcome: "workspace_conflict" };
      }
      const verified = await verifySlackInstallation(db, {
        ...key,
        botUserId: input.botUserId,
      });
      if (verified.outcome === "not_found") {
        throw new Error(
          `Slack installation ${key.appId}/${key.teamId} vanished after registering`,
        );
      }
      if (verified.outcome === "revoked") return { outcome: "revoked" };
      return { outcome: "verified", installationId: verified.installation.id };
    },
  };
}
