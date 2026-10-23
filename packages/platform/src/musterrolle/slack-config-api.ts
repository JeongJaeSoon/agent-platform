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

const updateAnswer = z.object({
  permissions_updated: z.boolean().optional(),
});

const ERROR_CODE = /^[a-z_]{1,64}$/;

export function createSlackConfigApi(options?: {
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SlackConfigApi {
  const apiUrl = (options?.apiUrl ?? SLACK_API_URL).replace(/\/+$/, "");
  const fetchImpl = options?.fetch ?? fetch;
  const timeoutMs = options?.timeoutMs ?? SLACK_HTTP_TIMEOUT_MS;

  async function call<T>(
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
  }

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
  };
}
