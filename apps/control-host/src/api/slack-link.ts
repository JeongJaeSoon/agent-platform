import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { verifyWithJwks } from "hono/jwt";

// Sign in with Slack (Slack's OpenID Connect), used only to prove which
// Slack account a logged-in person holds (design A.7). No Slack token is
// kept: the id_token is read once and dropped.

export type SlackOidcConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** `https://slack.com`, or a mock IdP's base URL in tests and local runs. */
  issuer: string;
};

export class SlackOidcConfigError extends Error {}

const SLACK_ISSUER = "https://slack.com";

/** The installation's Sign in with Slack settings, from SLACK_OIDC_*. */
export type SlackOidcSettings = {
  /** Also the console's address: Slack apps' redirects are made on its origin. */
  redirectUri: string;
  issuer: string;
  /** A hand-made OIDC app, for a workspace that has no link app. */
  client: { clientId: string; clientSecret: string } | null;
};

/**
 * Null when SLACK_OIDC_REDIRECT_URI is unset; linking then answers 503. The
 * redirect alone is enough: each workspace's link app is made on demand.
 * A client id and secret, set together, name a fallback app.
 */
export function slackOidcSettingsFromEnv(
  environment: Record<string, string | undefined>,
): SlackOidcSettings | null {
  const clientId = environment.SLACK_OIDC_CLIENT_ID || undefined;
  const clientSecret = environment.SLACK_OIDC_CLIENT_SECRET || undefined;
  const redirectUri = environment.SLACK_OIDC_REDIRECT_URI;
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new SlackOidcConfigError(
      "SLACK_OIDC_CLIENT_ID and SLACK_OIDC_CLIENT_SECRET are set together or not at all",
    );
  }
  if (!redirectUri) {
    if (clientId === undefined) return null;
    throw new SlackOidcConfigError(
      "SLACK_OIDC_CLIENT_ID and SLACK_OIDC_CLIENT_SECRET need SLACK_OIDC_REDIRECT_URI",
    );
  }
  const issuer = (environment.SLACK_OIDC_ISSUER || SLACK_ISSUER).replace(
    /\/+$/,
    "",
  );
  for (const [name, value] of [
    ["SLACK_OIDC_REDIRECT_URI", redirectUri],
    ["SLACK_OIDC_ISSUER", issuer],
  ] as const) {
    let protocol: string;
    try {
      protocol = new URL(value).protocol;
    } catch {
      throw new SlackOidcConfigError(`${name} must be an absolute URL`);
    }
    // Plain HTTP is for a local stack and its mock IdP.
    if (protocol !== "https:" && protocol !== "http:") {
      throw new SlackOidcConfigError(`${name} must be an http(s) URL`);
    }
  }
  return {
    redirectUri,
    issuer,
    client:
      clientId !== undefined && clientSecret !== undefined
        ? { clientId, clientSecret }
        : null,
  };
}

/** The startup warning when no workspace can link a Slack account; else null. */
export function signInWithSlackOff(
  settings: SlackOidcSettings | null,
  storeOn: boolean,
): string | null {
  if (settings === null) {
    return "Sign in with Slack is off (SLACK_OIDC_REDIRECT_URI unset); Slack accounts cannot be linked";
  }
  if (!storeOn && settings.client === null) {
    return "Sign in with Slack is off: no link app can be made without PLATFORM_SECRET_KEY, and no SLACK_OIDC_CLIENT_ID is set to fall back on";
  }
  return null;
}

// ---------------------------------------------------------------------------
// One-time state, held by the browser
// ---------------------------------------------------------------------------

export const SLACK_LINK_COOKIE_NAME = "ap_slack_link";
const SLACK_LINK_COOKIE_PATH = "/v1/linked-accounts/slack";
export const SLACK_LINK_TTL_MS = 10 * 60 * 1000;

export type SlackLinkState = { state: string; nonce: string; userId: string };

function token(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * State and nonce live in an HttpOnly cookie scoped to the callback, bound
 * to the person who started: a callback carrying someone else's code, or
 * replayed from another browser, finds no matching cookie.
 */
export function issueSlackLinkState(
  context: Context,
  userId: string,
  expiresAt: Date,
): SlackLinkState {
  const issued = { state: token(), nonce: token(), userId };
  setCookie(
    context,
    SLACK_LINK_COOKIE_NAME,
    `${issued.state}.${issued.nonce}.${userId}`,
    {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: SLACK_LINK_COOKIE_PATH,
      expires: expiresAt,
    },
  );
  return issued;
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Spends the cookie whatever the outcome; null unless it matches. */
export function consumeSlackLinkState(
  context: Context,
  state: string,
  userId: string,
): SlackLinkState | null {
  const raw = getCookie(context, SLACK_LINK_COOKIE_NAME);
  deleteCookie(context, SLACK_LINK_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: SLACK_LINK_COOKIE_PATH,
  });
  const [cookieState, nonce, cookieUser, ...rest] = raw?.split(".") ?? [];
  if (!cookieState || !nonce || !cookieUser || rest.length > 0) return null;
  if (!sameToken(cookieState, state) || cookieUser !== userId) return null;
  return { state: cookieState, nonce, userId: cookieUser };
}

// ---------------------------------------------------------------------------
// The OIDC exchange
// ---------------------------------------------------------------------------

export function slackAuthorizeUrl(
  config: SlackOidcConfig,
  issued: SlackLinkState,
  team: string | null,
): string {
  const url = new URL(`${config.issuer}/openid/connect/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    // No email: people are never matched by address.
    scope: "openid profile",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state: issued.state,
    nonce: issued.nonce,
    // Slack opens the consent screen on this team instead of asking.
    ...(team ? { team } : {}),
  }).toString();
  return url.toString();
}

export type VerifiedSlackAccount = { teamId: string; userId: string };

/** The IdP refused the code or returned a token that does not verify. */
export class SlackOidcRejectedError extends Error {}
/** The IdP could not be reached or answered with a server error. */
export class SlackOidcUnavailableError extends Error {}

const SLACK_HTTP_TIMEOUT_MS = 10_000;

async function slackFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(SLACK_HTTP_TIMEOUT_MS),
    });
    if (response.status >= 500) {
      throw new SlackOidcUnavailableError(`Slack answered ${response.status}`);
    }
    return response;
  } catch (error) {
    if (error instanceof SlackOidcUnavailableError) throw error;
    throw new SlackOidcUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function claim(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function exchangeSlackCode(
  config: SlackOidcConfig,
  code: string,
  expectedNonce: string,
): Promise<VerifiedSlackAccount> {
  const response = await slackFetch(
    `${config.issuer}/api/openid.connect.token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    id_token?: unknown;
    error?: unknown;
  } | null;
  if (!body?.ok || typeof body.id_token !== "string") {
    throw new SlackOidcRejectedError(
      `Slack refused the code: ${typeof body?.error === "string" ? body.error : "no id_token"}`,
    );
  }
  const jwks = await slackFetch(`${config.issuer}/openid/connect/keys`, {});
  const keys = ((await jwks.json().catch(() => null)) as { keys?: unknown })
    ?.keys;
  if (!Array.isArray(keys)) {
    throw new SlackOidcUnavailableError("Slack answered no signing keys");
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await verifyWithJwks(body.id_token, {
      keys,
      allowedAlgorithms: ["RS256"],
      verification: { iss: config.issuer, aud: config.clientId },
    })) as Record<string, unknown>;
  } catch (error) {
    throw new SlackOidcRejectedError(
      `id_token did not verify: ${error instanceof Error ? error.name : "error"}`,
    );
  }
  const nonce = claim(payload, "nonce");
  if (nonce === null || !sameToken(nonce, expectedNonce)) {
    throw new SlackOidcRejectedError("id_token nonce does not match");
  }
  const teamId = claim(payload, "https://slack.com/team_id");
  const userId =
    claim(payload, "https://slack.com/user_id") ?? claim(payload, "sub");
  if (teamId === null || userId === null) {
    throw new SlackOidcRejectedError("id_token names no Slack team or user");
  }
  return { teamId, userId };
}
