import { randomBytes, timingSafeEqual } from "node:crypto";
import { GITHUB_LOGIN_PATTERN } from "@werft-ai/contracts";
import type { GitHubOAuthClient } from "@werft-ai/platform";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

// Linking a person's GitHub account through the author App's user
// authorization (design github-agent.md decision 5). The user token answers
// one `GET /user` and is dropped; nothing of it is kept or logged.

/** The console page GitHub sends the person back to. */
export function githubCallbackUrl(consoleOrigin: string | null): string | null {
  return consoleOrigin === null
    ? null
    : new URL("/settings/linked-accounts/github", consoleOrigin).toString();
}

// ---------------------------------------------------------------------------
// State held by the browser: the callback spends its cookie, the server keeps
// no record (as for Slack), and GitHub's code is single-use on its side
// ---------------------------------------------------------------------------

export const GITHUB_LINK_COOKIE_NAME = "ap_github_link";
const GITHUB_LINK_COOKIE_PATH = "/v1/linked-accounts/github";
export const GITHUB_LINK_TTL_MS = 10 * 60 * 1000;

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: GITHUB_LINK_COOKIE_PATH,
} as const;

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The state rides in an HttpOnly cookie scoped to the callback and bound to
 * the person who started, with its expiry, which the callback checks too.
 */
export function issueGitHubLinkState(
  context: Context,
  userId: string,
  expiresAt: Date,
): string {
  const state = randomBytes(32).toString("base64url");
  setCookie(
    context,
    GITHUB_LINK_COOKIE_NAME,
    `${state}.${userId}.${expiresAt.getTime()}`,
    { ...cookieOptions, expires: expiresAt },
  );
  return state;
}

/** Spends the cookie whatever the outcome; false unless it matches in time. */
export function consumeGitHubLinkState(
  context: Context,
  state: string,
  userId: string,
  now: Date = new Date(),
): boolean {
  const raw = getCookie(context, GITHUB_LINK_COOKIE_NAME);
  deleteCookie(context, GITHUB_LINK_COOKIE_NAME, cookieOptions);
  const [cookieState, cookieUser, expires, ...rest] = raw?.split(".") ?? [];
  if (!cookieState || !cookieUser || !expires || rest.length > 0) return false;
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) {
    return false;
  }
  return sameToken(cookieState, state) && cookieUser === userId;
}

// ---------------------------------------------------------------------------
// The OAuth exchange
// ---------------------------------------------------------------------------

export function githubAuthorizeUrl(
  client: Pick<GitHubOAuthClient, "clientId" | "webBase">,
  redirectUri: string,
  state: string,
): string {
  const url = new URL("/login/oauth/authorize", client.webBase);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state,
    // Linking proves an account someone has; it never makes one.
    allow_signup: "false",
  }).toString();
  return url.toString();
}

export type VerifiedGitHubAccount = { id: string; login: string };

/** GitHub refused the code, or named an account that does not check out. */
export class GitHubOAuthRejectedError extends Error {}
/** GitHub could not be reached or answered with a server error. */
export class GitHubOAuthUnavailableError extends Error {}

const GITHUB_HTTP_TIMEOUT_MS = 10_000;

async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(GITHUB_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubOAuthUnavailableError(
      error instanceof Error ? error.name : "fetch failed",
    );
  }
  if (response.status >= 500) {
    throw new GitHubOAuthUnavailableError(`GitHub answered ${response.status}`);
  }
  return response;
}

/**
 * The code for a user token, the token for `GET /user`'s id and login.
 * Error messages name a status or GitHub's error code, never a value sent.
 */
export async function exchangeGitHubCode(
  client: GitHubOAuthClient,
  code: string,
  redirectUri: string,
): Promise<VerifiedGitHubAccount> {
  const exchanged = await githubFetch(
    new URL("/login/oauth/access_token", client.webBase).toString(),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    },
  );
  const answer = (await exchanged.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
  } | null;
  const accessToken = answer?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    const reason = answer?.error;
    throw new GitHubOAuthRejectedError(
      `GitHub refused the code: ${typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : exchanged.status}`,
    );
  }
  const user = await githubFetch(
    new URL("user", client.apiBase.replace(/\/*$/, "/")).toString(),
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!user.ok) {
    throw new GitHubOAuthRejectedError(`GET /user answered ${user.status}`);
  }
  const body = (await user.json().catch(() => null)) as {
    id?: unknown;
    login?: unknown;
  } | null;
  const id = body?.id;
  const login = body?.login;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof login !== "string" ||
    !GITHUB_LOGIN_PATTERN.test(login)
  ) {
    throw new GitHubOAuthRejectedError("GET /user named no usable account");
  }
  return { id: String(id), login };
}
