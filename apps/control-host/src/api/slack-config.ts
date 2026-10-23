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
 * The console's origin, taken from SLACK_OIDC_REDIRECT_URI (the account
 * linking callback, which the console serves); null when it is unset.
 */
export function consoleOriginFrom(
  env: Record<string, string | undefined>,
): string | null {
  const value = env.SLACK_OIDC_REDIRECT_URI;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    throw new SlackConfigError(
      "SLACK_OIDC_REDIRECT_URI must be an absolute URL",
    );
  }
}
