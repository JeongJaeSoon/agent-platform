import type { SlackUser, SurfaceChannelKind } from "@werft-ai/contracts";
import { z } from "zod";

// The App Configuration API calls the platform makes with a workspace's
// config token: rotating the token and creating, updating and deleting the
// apps it made. Answers are parsed with zod and errors carry only Slack's
// error code, never a body: the body of a create answer holds secrets.

export const SLACK_API_URL = "https://slack.com/api";
export const SLACK_HTTP_TIMEOUT_MS = 10_000;

/**
 * `answered`: Slack said no (`ok:false`), so nothing changed on its side.
 * Otherwise the call may or may not have taken effect: Slack was
 * unreachable, timed out or answered something unreadable.
 */
export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly answered: boolean,
  ) {
    super(`${method}: ${code}`);
    this.name = "SlackApiError";
  }
}

export type RotatedConfigToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  issuerUserId: string;
  issuerTeamId: string;
};

export type CreatedSlackApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
};

export interface SlackConfigApi {
  rotateConfigToken(refreshToken: string): Promise<RotatedConfigToken>;
  createApp(configToken: string, manifest: object): Promise<CreatedSlackApp>;
  updateApp(
    configToken: string,
    appId: string,
    manifest: object,
  ): Promise<{ permissionsUpdated: boolean }>;
  deleteApp(configToken: string, appId: string): Promise<void>;
}

/** What `oauth.v2.access` granted, before it is checked. */
export type SlackInstallGrant = {
  botToken: string;
  appId: string;
  /** Null for an enterprise-wide install, which names no team. */
  teamId: string | null;
  enterpriseInstall: boolean;
  scopes: string[];
};

export type SlackBotIdentity = {
  teamId: string;
  botUserId: string;
  appId: string;
};

/** The calls that install an app and check the bot token it returns. */
export interface SlackInstallApi {
  exchangeInstallCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<SlackInstallGrant>;
  /** `auth.test` names the team and bot user; `bots.info` names the app. */
  botIdentity(botToken: string): Promise<SlackBotIdentity>;
}

const slackId = z.string().regex(/^[A-Z0-9]{1,64}$/);
const opaque = z.string().regex(/^[\x21-\x7e]{1,4096}$/);

const rotateAnswer = z.object({
  token: opaque,
  refresh_token: opaque,
  team_id: slackId,
  user_id: slackId,
  exp: z.number().int().positive(),
});

const createAnswer = z.object({
  app_id: slackId,
  credentials: z.object({
    client_id: z.string().regex(/^[0-9.]{1,64}$/),
    client_secret: opaque,
    signing_secret: opaque,
  }),
});

const installAnswer = z.object({
  access_token: opaque,
  token_type: z.literal("bot"),
  scope: z.string().max(4096),
  app_id: slackId,
  team: z.object({ id: slackId }).nullish(),
  is_enterprise_install: z.boolean().optional(),
});

const authTestAnswer = z.object({
  team_id: slackId,
  user_id: slackId,
  bot_id: slackId,
});

const botsInfoAnswer = z.object({
  bot: z.object({ app_id: slackId }),
});

const updateAnswer = z.object({
  permissions_updated: z.boolean().optional(),
});

const ERROR_CODE = /^[a-z_]{1,64}$/;

export type SlackApiOptions = {
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

function slackCaller(options?: SlackApiOptions) {
  const apiUrl = (options?.apiUrl ?? SLACK_API_URL).replace(/\/+$/, "");
  const fetchImpl = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? SLACK_HTTP_TIMEOUT_MS;

  return async function call<T>(
    method: string,
    init: { token?: string; body: URLSearchParams | object },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const json = !(init.body instanceof URLSearchParams);
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}/${method}`, {
        method: "POST",
        headers: {
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          "Content-Type": json
            ? "application/json; charset=utf-8"
            : "application/x-www-form-urlencoded",
        },
        body: json ? JSON.stringify(init.body) : init.body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SlackApiError(
        method,
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "unreachable",
        false,
      );
    }
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (body === null || typeof body !== "object") {
      throw new SlackApiError(method, `http_${response.status}`, false);
    }
    if (body.ok !== true) {
      // A 5xx with ok:false still leaves doubt about what Slack did.
      const answered = response.status < 500;
      const code =
        typeof body.error === "string" && ERROR_CODE.test(body.error)
          ? body.error
          : `http_${response.status}`;
      throw new SlackApiError(method, code, answered);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new SlackApiError(method, "unexpected_answer", false);
    }
    return parsed.data;
  };
}

export function createSlackConfigApi(
  options?: SlackApiOptions,
): SlackConfigApi & SlackInstallApi {
  const call = slackCaller(options);
  return {
    async rotateConfigToken(refreshToken) {
      const answer = await call(
        "tooling.tokens.rotate",
        { body: new URLSearchParams({ refresh_token: refreshToken }) },
        rotateAnswer,
      );
      return {
        accessToken: answer.token,
        refreshToken: answer.refresh_token,
        expiresAt: new Date(answer.exp * 1000),
        issuerUserId: answer.user_id,
        issuerTeamId: answer.team_id,
      };
    },

    async createApp(configToken, manifest) {
      const answer = await call(
        "apps.manifest.create",
        { token: configToken, body: { manifest: JSON.stringify(manifest) } },
        createAnswer,
      );
      return {
        appId: answer.app_id,
        clientId: answer.credentials.client_id,
        clientSecret: answer.credentials.client_secret,
        signingSecret: answer.credentials.signing_secret,
      };
    },

    async updateApp(configToken, appId, manifest) {
      const answer = await call(
        "apps.manifest.update",
        {
          token: configToken,
          body: { app_id: appId, manifest: JSON.stringify(manifest) },
        },
        updateAnswer,
      );
      return { permissionsUpdated: answer.permissions_updated === true };
    },

    async deleteApp(configToken, appId) {
      await call(
        "apps.manifest.delete",
        { token: configToken, body: { app_id: appId } },
        z.object({}),
      );
    },

    async exchangeInstallCode(input) {
      const answer = await call(
        "oauth.v2.access",
        {
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            code: input.code,
            redirect_uri: input.redirectUri,
          }),
        },
        installAnswer,
      );
      return {
        botToken: answer.access_token,
        appId: answer.app_id,
        teamId: answer.team?.id ?? null,
        enterpriseInstall: answer.is_enterprise_install === true,
        scopes: answer.scope.split(",").filter((scope) => scope.length > 0),
      };
    },

    async botIdentity(botToken) {
      const auth = await call(
        "auth.test",
        { token: botToken, body: new URLSearchParams() },
        authTestAnswer,
      );
      const info = await call(
        "bots.info",
        { token: botToken, body: new URLSearchParams({ bot: auth.bot_id }) },
        botsInfoAnswer,
      );
      return {
        teamId: auth.team_id,
        botUserId: auth.user_id,
        appId: info.bot.app_id,
      };
    },
  };
}

/** The progress line under a thread's last message (94S-791). */
export const SLACK_SET_STATUS_METHOD = "agents.sessions.setStatus";

/** The calls a bot token makes about the people and places it hears from. */
export interface SlackBotApi {
  /** `users.info`: the flags that tell a member from a guest or a stranger. */
  userInfo(botToken: string, userId: string): Promise<SlackUser>;
  /** `conversations.info`: what kind of place the channel is. */
  channelKind(botToken: string, channelId: string): Promise<SurfaceChannelKind>;
  setStatus(
    botToken: string,
    input: { channelId: string; threadTs: string; status: string },
  ): Promise<void>;
}

const userInfoAnswer = z.object({
  user: z.object({
    id: slackId,
    team_id: slackId,
    is_restricted: z.boolean().optional(),
    is_ultra_restricted: z.boolean().optional(),
    is_stranger: z.boolean().optional(),
  }),
});

const conversationInfoAnswer = z.object({
  channel: z.object({
    is_im: z.boolean().optional(),
    is_mpim: z.boolean().optional(),
    is_private: z.boolean().optional(),
  }),
});

export function createSlackBotApi(options?: SlackApiOptions): SlackBotApi {
  const call = slackCaller(options);
  return {
    async userInfo(botToken, userId) {
      const { user } = await call(
        "users.info",
        { token: botToken, body: new URLSearchParams({ user: userId }) },
        userInfoAnswer,
      );
      return {
        id: user.id,
        team_id: user.team_id,
        ...(user.is_restricted === undefined
          ? {}
          : { is_restricted: user.is_restricted }),
        ...(user.is_ultra_restricted === undefined
          ? {}
          : { is_ultra_restricted: user.is_ultra_restricted }),
        ...(user.is_stranger === undefined
          ? {}
          : { is_stranger: user.is_stranger }),
      };
    },

    async channelKind(botToken, channelId) {
      const { channel } = await call(
        "conversations.info",
        { token: botToken, body: new URLSearchParams({ channel: channelId }) },
        conversationInfoAnswer,
      );
      if (channel.is_im) return "dm";
      // A group DM is as closed as a private channel.
      return channel.is_private || channel.is_mpim
        ? "private_channel"
        : "public_channel";
    },

    async setStatus(botToken, input) {
      await call(
        SLACK_SET_STATUS_METHOD,
        {
          token: botToken,
          body: {
            channel_id: input.channelId,
            thread_ts: input.threadTs,
            status: input.status,
          },
        },
        z.object({}),
      );
    },
  };
}
