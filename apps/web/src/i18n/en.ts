import { flowEn, formsEn, sessionsEn } from "@werft-ai/react";
import { agentGitHubEn } from "./agent-github.ts";
import { agentsEn } from "./agents.ts";
import { apiKeysEn } from "./api-keys.ts";
import { authEn } from "./auth.ts";
import { commonEn } from "./common.ts";
import { errorsEn } from "./errors.ts";
import { githubEn } from "./github.ts";
import { homeEn } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedEn } from "./linked.ts";
import { membersEn } from "./members.ts";
import { modelsEn } from "./models.ts";
import { outputsEn } from "./outputs.ts";
import { preferencesEn } from "./preferences.ts";
import { profilesEn } from "./profiles.ts";
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
  "slack.joinHintAuto":
    "The bot automatically joins public channels when responses are enabled. Invite the bot to private channels with /invite.",
  "slack.appId": "App ID",
  "slack.state.none": "Not created",
  "slack.state.pending": "Awaiting installation",
  "slack.state.connected": "Connected",
  "slack.state.reinstall": "Reinstall required",
  "slack.eventsPending.title": "Slack has not checked the Request URL yet",
  "slack.eventsPending.body":
    "Slack sends no invites, mentions or DMs until it has checked this app's Request URL. Send the URL again with Recheck under Advanced. If this notice stays, press Verify (or Retry) for the Request URL on the app's Event Subscriptions page. It goes away once Slack's check arrives.",
  "slack.eventsPending.open": "Open Event Subscriptions",
  "slack.channelsLocked.title":
    "Channels can't be picked until Slack checks the Request URL",
  "slack.channelsLocked.body":
    "Channels send no events until Slack has checked this app's Request URL. Send the URL again with Recheck under Advanced. This unlocks as soon as Slack checks it.",
  "slack.channelsLocked.action": "Go to Recheck",
  "slack.eventsUrl.title": "Events Request URL",
  "slack.eventsUrl.hint":
    "Where Slack sends invites, mentions and DMs. Recheck sends the URL to the app's settings again and answers Slack's check automatically.",
  "slack.eventsUrl.verified": "Checked by Slack",
  "slack.eventsUrl.pending": "Waiting for Slack",
  "slack.eventsUrl.failed": "Registration failed",
  "slack.eventsUrl.unsent": "Not sent yet",
  "slack.eventsUrl.recheck": "Recheck",
  "slack.eventsUrl.done": "Slack has checked the Request URL.",
  "slack.eventsUrl.sent":
    "The Request URL was sent to Slack again. The status changes once Slack checks it.",
  "slack.repositoryRequired.title": "Sessions can't start from Slack",
  "slack.repositoryRequired.body":
    "The active release's profile ({profile}) needs a repository for every session, and the release has none it can use (none was chosen, or it left the catalog). Slack mentions and DMs are refused and only a notice is left in the thread. You can still connect. Create a release with a repository on the Release tab and activate it.",
  "slack.profileUnavailable.title": "Sessions can't start from Slack",
  "slack.profileUnavailable.body":
    "The active release's profile ({profile}) is no longer in the catalog, changed after the release, or was blocked by the operator. Slack mentions and DMs are refused and only a notice is left in the thread. Create a release under a profile you can use on the Release tab and activate it.",
  "slack.noActiveRelease.title": "No active release",
  "slack.noActiveRelease.body":
    "Until a release is activated, Slack mentions and DMs are refused and only a notice is left in the thread. Create and activate a release on the Release tab.",
  "slack.state.error": "Error",
  "slack.createInstall": "Create and install Slack app",
  "slack.install": "Install Slack app",
  "slack.reinstall": "Reinstall",
  "slack.working": "Preparing…",
  "slack.refresh": "Refresh",
  "slack.delete": "Delete app",
  "slack.deleteTitle": "Delete the Slack app",
  "slack.deleteWarning":
    "Deletes the app in Slack along with its stored credentials. This can't be undone; connecting again makes a new app.",
  "slack.deleted": "Slack app deleted.",
  "slack.revoke": "Disconnect",
  "slack.revokeTitle": "Disconnect Slack",
  "slack.revokeWarning":
    "Revoke this agent's Slack identity and channel bindings. Subsequent events will not be received; the Slack app stays and can be installed again.",
  "slack.revoked": "Slack disconnected.",
  "slack.activateFirst": "Turn on the agent before creating its Slack app.",
  "slack.channels": "Channels",
  "slack.sectionNav": "Slack sections",
  "slack.manage": "Manage",
  "slack.saved": "Channel use saved.",
  "slack.homeSaved": "Home channel set.",
  "slack.channelConnected": "Channel connected.",
  "slack.dmSaved": "DM setting saved.",
  "slack.mentionOnlySavedOn": "Responds only when @mentioned.",
  "slack.mentionOnlySavedOff": "Responds without a mention too.",
  "slack.home": "Home channel",
  "slack.setHome": "Set home",
  "slack.homeStep": "Set a home channel",
  "slack.pickHome": "Choose home channel",
  "slack.homeStepHint":
    "First choose the home channel where the agent posts its introduction and notices. The channel you choose is in use right away. For a private channel, invite the bot there with /invite.",
  "slack.channelHome": "Set home: {channel}",
  "slack.channelConnect": "Connect {channel}",
  "slack.connectedChannels": "Connected channels",
  "slack.noConnectedChannels": "No connected channels",
  "slack.addChannelHint":
    "Choose Add channel to select where this agent responds.",
  "slack.addChannel": "Add channel",
  "slack.basic": "Basic",
  "slack.advanced": "Advanced",
  "slack.connection": "Connection",
  "slack.status": "Status",
  "slack.homeChannel": "Home channel",
  "slack.homeUnset": "Not selected",
  "slack.channelId": "Channel ID: {id}",
  "slack.channelsLoading": "Loading channels",
  "slack.danger": "Danger zone",
  "slack.botId": "Bot ID",
  "slack.mentionOnlyHint":
    "On: responds only when @mentioned. Off: responds to posts in the channel without a mention too. Either way, replies in a thread it is already talking in get an answer without a mention.",
  "slack.dm": "Direct messages",
  "slack.dmSetting": "Receive DMs",
  "slack.dmHint":
    "Receive one-to-one conversations in the Slack app's Messages tab. Only members who linked their Slack account can use it.",
  "slack.public": "Public",
  "slack.private": "Private",
  "slack.off": "Off",
  "slack.on": "On",
  "slack.inUse": "Use in this channel",
  "slack.inUseOf": "Use in {channel}",
  "slack.mentionOnly": "Respond only when mentioned",
  "slack.search": "Find channels",
  "slack.invite": "Waiting to join",
  "slack.privateInvite": "/invite required",
  "slack.add": "Connect",
  "slack.noChannels":
    "No channels found. Invite the bot to private channels with /invite first.",
  "slack.partial":
    "Some channels may be missing or results may be out of date.",
  "slack.more": "Load more",
  "slack.reinstallTitle": "Reinstall the Slack app",
  "slack.reinstallHint":
    "Reinstall when permissions or event settings change. Opens Slack's consent screen.",
  "slack.installHint":
    "Opens Slack's consent screen to install the app in this workspace.",
  "slack.installed": "Installed the app in Slack.",
  "slack.copyInvite": "Copy /invite command",
  "slack.inviteCommand": "/invite command",
  "slack.copied": "Copied",
  "slack.copy": "Copy",
  "slack.copyAppId": "Copy app ID",
  "slack.copyAppIdFailed":
    "Couldn't copy to the clipboard. Select the app ID and copy it yourself.",
  "slack.openInSlack": "Open in Slack",
  "slack.newTab": "(opens in a new tab)",
  "slack.copyFailed":
    "Couldn't copy to the clipboard. Copy the selected command yourself.",
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
  ...profilesEn,
  ...sessionsEn,
  ...sessionListEn,
  ...flowEn,
  ...linkedEn,
  ...outputsEn,
  ...apiKeysEn,
  ...workspaceEn,
  ...githubEn,
  ...agentGitHubEn,
  ...usageEn,
  ...preferencesEn,
  ...errorsEn,
  ...formsEn,
};
