import { flowEn, formsEn, sessionsEn } from "@werft-ai/react";
import { agentsEn } from "./agents.ts";
import { apiKeysEn } from "./api-keys.ts";
import { authEn } from "./auth.ts";
import { commonEn } from "./common.ts";
import { errorsEn } from "./errors.ts";
import { homeEn } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedEn } from "./linked.ts";
import { membersEn } from "./members.ts";
import { modelsEn } from "./models.ts";
import { outputsEn } from "./outputs.ts";
import { preferencesEn } from "./preferences.ts";
import { sessionListEn } from "./session-list.ts";
import { shellEn } from "./shell.ts";
import { teamsEn } from "./teams.ts";
import { usageEn } from "./usage.ts";
import { workspaceEn } from "./workspace.ts";

export const slackEn = {
  "slack.error.config":
    "Slack app creation needs workspace configuration. Ask an administrator to configure it.",
  "slack.error.creating":
    "App creation is still being checked. Ask an administrator to check Slack for the app, then refresh.",
  "slack.error.notInstalled":
    "Install the Slack app before connecting channels.",
  "slack.error.denied":
    "Slack installation was declined. You can install again from the Slack tab.",
  "slack.error.expired":
    "The installation link expired or was already used. Install again from the Slack tab.",
  "slack.error.rejected":
    "The Slack app or workspace did not match. Start again from the Slack tab.",
  "slack.error.cursor":
    "The channel list changed. Refresh to search again from the beginning.",
  "agent.tabs.slack": "Slack",
  "agents.flow.channels": "Connect channels",
  "slack.app": "Slack app",
  "slack.verifyNeeded":
    "The app is installed, but event registration needs verification. Contact your administrator.",
  "slack.joinHint":
    "Invite the bot to public and private channels with /invite. Connecting a channel does not join it automatically.",
  "slack.appId": "App ID",
  "slack.state.none": "Not created",
  "slack.state.pending": "Awaiting installation",
  "slack.state.connected": "Connected",
  "slack.state.reinstall": "Reinstall required",
  "slack.state.error": "Error",
  "slack.createInstall": "Create and install Slack app",
  "slack.install": "Install Slack app",
  "slack.reinstall": "Reinstall",
  "slack.working": "Preparing…",
  "slack.refresh": "Refresh",
  "slack.delete": "Delete app",
  "slack.deleteWarning":
    "Delete the Slack app and its stored credentials. Messages through this app will no longer be received.",
  "slack.deleted": "Slack app deleted.",
  "slack.revoke": "Disconnect",
  "slack.revokeWarning":
    "Revoke this agent's Slack identity and channel bindings. Subsequent events will not be received.",
  "slack.revoked": "Slack disconnected.",
  "slack.activateFirst": "Turn on the agent before creating its Slack app.",
  "slack.channels": "Channels",
  "slack.overview": "Overview",
  "slack.settings": "Settings",
  "slack.sections": "Slack management",
  "slack.saved": "Channel response saved.",
  "slack.homeSaved": "Home channel set.",
  "slack.channelConnected": "Channel connected.",
  "slack.dmSaved": "Direct message setting saved.",
  "slack.ambient": "Always respond",
  "slack.notConfigured": "Not configured",
  "slack.home": "Home",
  "slack.setHome": "Set home",
  "slack.channelHome": "Set home: {channel}",
  "slack.channelConnect": "Connect {channel}",
  "slack.connectedChannels": "Connected channels",
  "slack.addChannel": "Add channel",
  "slack.basic": "Basic",
  "slack.advanced": "Advanced",
  "slack.connection": "Connection",
  "slack.status": "Status",
  "slack.homeChannel": "Home channel",
  "slack.homeUnset": "Not selected",
  "slack.change": "Change",
  "slack.changeHome": "Change home channel",
  "slack.channelId": "Channel ID: {id}",
  "slack.channelsLoading": "Loading channels",
  "slack.danger": "Danger zone",
  "slack.botId": "Bot ID",
  "slack.defaultHint":
    "Applies only to channels newly connected from this screen. Existing channels are unchanged.",
  "slack.dm": "Direct messages",
  "slack.dmHint":
    "Receive one-to-one conversations from linked members in the Slack app's Messages tab.",
  "slack.public": "Public",
  "slack.private": "Private",
  "slack.off": "Off",
  "slack.mention": "When mentioned",
  "slack.reaction": "Respond when mentioned in {channel}",
  "slack.defaultReaction": "Respond when mentioned in newly connected channels",
  "slack.search": "Find channels",
  "slack.invite": "Awaiting participation",
  "slack.privateInvite": "/invite required",
  "slack.add": "Connect",
  "slack.noChannels":
    "No channels found. Invite the bot to private channels with /invite first.",
  "slack.partial":
    "Some channels may be missing or results may be out of date.",
  "slack.more": "Load more",
} as const;

export const en: Record<MessageKey, string> = {
  ...slackEn,
  ...commonEn,
  ...shellEn,
  ...authEn,
  ...homeEn,
  ...membersEn,
  ...teamsEn,
  ...agentsEn,
  ...modelsEn,
  ...sessionsEn,
  ...sessionListEn,
  ...flowEn,
  ...linkedEn,
  ...outputsEn,
  ...apiKeysEn,
  ...workspaceEn,
  ...usageEn,
  ...preferencesEn,
  ...errorsEn,
  ...formsEn,
};
