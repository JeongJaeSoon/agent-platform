import { SLACK_API_URL } from "@werft-ai/platform";

const PLAIN_HTTP_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "mock-slack",
]);

export class SlackConfigError extends Error {}

/** SLACK_API_URL, or Slack's own; tokens ride in a header, so https only. */
export function slackApiUrlFrom(
  env: Record<string, string | undefined>,
): string {
  const value = (env.SLACK_API_URL || SLACK_API_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackConfigError("SLACK_API_URL must be an absolute URL");
  }
  const local = PLAIN_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SlackConfigError(
      "SLACK_API_URL must be https (http only for a local mock)",
    );
  }
  return value;
}

/**
 * SLACK_EVENTS_PUBLIC_URL: the base Slack reaches the events route under,
 * without `/v1/slack/events/...`. Slack calls https request URLs only.
 */
export function slackEventsPublicUrlFrom(
  env: Record<string, string | undefined>,
): string | null {
  const value = env.SLACK_EVENTS_PUBLIC_URL;
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackConfigError(
      "SLACK_EVENTS_PUBLIC_URL must be an absolute URL",
    );
  }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
    throw new SlackConfigError(
      "SLACK_EVENTS_PUBLIC_URL must be an https URL without a query",
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * The console's origin: CONSOLE_ORIGIN, else that of SLACK_OIDC_REDIRECT_URI
 * (the account linking callback, which the console serves); null when
 * neither is set.
 */
export function consoleOriginFrom(
  env: Record<string, string | undefined>,
): string | null {
  for (const name of ["CONSOLE_ORIGIN", "SLACK_OIDC_REDIRECT_URI"] as const) {
    const value = env[name];
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SlackConfigError(`${name} must be an absolute URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new SlackConfigError(`${name} must be an http(s) URL`);
    }
    return url.origin;
  }
  return null;
}
