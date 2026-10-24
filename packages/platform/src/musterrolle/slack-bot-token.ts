import { SLACK_BINDING_MESSAGES } from "@werft-ai/contracts";
import type { SecretStore } from "../ports/secret-store.ts";
import type { SlackAppStore } from "../ports/slack-app-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import type { SlackChannelKinds } from "./surface-binding-service.ts";

/** The bot token an install stored for the app; null when it has none. */
export function slackBotToken(
  secrets: Pick<SecretStore, "get">,
  workspaceId: string,
  slackAppId: string,
): Promise<string | null> {
  return secrets.get({
    workspaceId,
    owner: { kind: "slack_app", id: slackAppId },
    purpose: "slack_bot_token",
  });
}

/**
 * Channel kinds as the agent's own app sees them. Without a secret store
 * (no master key) there is no bot token to ask with, so a channel cannot
 * be bound.
 */
export function createSlackChannelKinds(deps: {
  apps: Pick<SlackAppStore, "findForAgent"> | null;
  secrets: Pick<SecretStore, "get"> | null;
  slack: SlackBotApi;
}): SlackChannelKinds {
  const notInstalled = () =>
    new SessionServiceError(
      "SLACK_NOT_INSTALLED",
      SLACK_BINDING_MESSAGES.notInstalled,
    );
  return {
    async kindOf(workspaceId, agentId, channelId) {
      if (deps.apps === null || deps.secrets === null) throw notInstalled();
      const app = await deps.apps.findForAgent(workspaceId, agentId);
      const token =
        app === null
          ? null
          : await slackBotToken(deps.secrets, workspaceId, app.id);
      if (token === null) throw notInstalled();
      try {
        return await deps.slack.channelKind(token, channelId);
      } catch (error) {
        if (error instanceof SlackApiError && error.answered) {
          throw new SessionServiceError(
            "BAD_REQUEST",
            SLACK_BINDING_MESSAGES.channelUnknown,
            undefined,
            { slack_error: error.code },
          );
        }
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          SLACK_BINDING_MESSAGES.slackUnavailable,
          { afterSeconds: 10 },
        );
      }
    },
  };
}
