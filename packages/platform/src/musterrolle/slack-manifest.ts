import { BOT_SCOPES, SLACK_AGENT_BOT_EVENTS } from "@werft-ai/contracts";

// Slack's limits on what a manifest may say about an app.
const APP_NAME_MAX = 35;
const BOT_NAME_MAX = 80;
const AGENT_DESCRIPTION_MAX = 300;

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export type AgentAppManifestInput = {
  /** The agent's name, shown as the app's. */
  name: string;
  /** The agent's slug: a bot display name allows only a-z, 0-9, `-_.`. */
  botName: string;
  /** The active release card's role. */
  description: string;
  redirectUrl: string;
  /**
   * The events route for this agent. Absent at creation: Slack checks the
   * URL with a challenge signed by a secret the app does not have yet, so
   * Finalize adds it once the route can answer.
   */
  eventsUrl?: string;
};

const clip = (value: string, max: number) =>
  [...value].length > max ? [...value].slice(0, max).join("") : value;

/**
 * Always the whole manifest: `apps.manifest.update` replaces the document,
 * so the update Finalize sends must carry everything creation did. The
 * agent app has no user scopes; Sign in with Slack is the link app's.
 */
export function buildAgentAppManifest(input: AgentAppManifestInput) {
  const name = clip(input.name.trim(), APP_NAME_MAX);
  return {
    display_information: { name },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: clip(input.botName, BOT_NAME_MAX),
        always_online: true,
      },
      agent_view: {
        agent_description: clip(input.description.trim(), AGENT_DESCRIPTION_MAX),
      },
    },
    oauth_config: {
      redirect_urls: [input.redirectUrl],
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      ...(input.eventsUrl === undefined
        ? {}
        : {
            event_subscriptions: {
              request_url: input.eventsUrl,
              bot_events: [...SLACK_AGENT_BOT_EVENTS],
            },
          }),
    },
  };
}

/** The console page Slack sends the installer back to. */
export function slackAppRedirectUrl(
  consoleOrigin: string,
  agentId: string,
): string {
  return new URL(
    `/agents/${encodeURIComponent(agentId.toLowerCase())}/slack/callback`,
    consoleOrigin,
  ).toString();
}

/**
 * Where a workspace admin approves installing the app. The OAuth `state`
 * that binds the answer to its requester is added by the install flow.
 */
export function slackAuthorizeUrl(input: {
  clientId: string;
  redirectUrl: string;
  state?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: BOT_SCOPES.join(","),
    redirect_uri: input.redirectUrl,
  });
  if (input.state !== undefined) params.set("state", input.state);
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}
