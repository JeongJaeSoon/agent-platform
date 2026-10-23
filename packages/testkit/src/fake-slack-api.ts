import { createHmac, randomBytes } from "node:crypto";

// Slack's Web API over HTTP, for tests and the local stack: whatever reads
// SLACK_API_URL can be pointed at `<url>/api`. Every token it hands out is
// made here at runtime; none is a real credential.

export type FakeSlackApp = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  manifest: unknown;
  /** Bot tokens issued by oauth.v2.access for this app. */
  botTokens: string[];
};

/** One call as the fake saw it: method and outcome, never a token. */
export type FakeSlackCall = { method: string; ok: boolean; error?: string };

export type FakeSlackWebApi = {
  /** Answers `/api/<method>` and the fake's own routes; null for anything else. */
  handle(request: Request): Promise<Response | null>;
  /** A refresh token tooling.tokens.rotate takes once, as a pasted config token. */
  issueConfigToken(): string;
  /** Follows an authorize URL as an approving admin would; returns the code. */
  authorize(authorizeUrl: string): { code: string; state: string | null };
  apps: Map<string, FakeSlackApp>;
  calls: FakeSlackCall[];
  /** Fields merged into every apps.manifest.update answer. */
  manifestUpdateAnswer: Record<string, unknown>;
  /**
   * Posts an event to `url` as Slack would, signed with the app's secret:
   * `ageSeconds` backdates the timestamp (negative: from the future),
   * `challenge` sends a url_verification instead. Answers what came back.
   */
  sendEvent(input: SendSlackEventInput): Promise<{
    status: number;
    body: unknown;
    eventId: string | null;
  }>;
  /** Fields merged into every oauth.v2.access answer, to mimic a bad one. */
  installAnswer: Record<string, unknown>;
};

export type SendSlackEventInput = {
  url: string;
  appId: string;
  event?: Record<string, unknown>;
  eventId?: string;
  teamId?: string;
  ageSeconds?: number;
  retryNum?: number;
  challenge?: string;
};

type Context = {
  token: string | null;
  params: Record<string, string>;
};

class SlackError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function createFakeSlackWebApi(
  options: {
    teamId?: string;
    /** The Slack user whose config token this is. */
    userId?: string;
    /** Seconds an access token lives; Slack's is 12 hours. */
    accessTtlSeconds?: number;
  } = {},
): FakeSlackWebApi {
  const teamId = options.teamId ?? "T0MOCK";
  const userId = options.userId ?? "U0MOCK";
  const ttl = options.accessTtlSeconds ?? 12 * 3600;
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const codes = new Map<string, { appId: string; redirectUri: string }>();
  const apps = new Map<string, FakeSlackApp>();
  const calls: FakeSlackCall[] = [];
  /** The scopes each pending code's authorize URL asked for. */
  const scopesOf = new Map<string, string>();
  const installAnswer: Record<string, unknown> = {};
  const manifestUpdateAnswer: Record<string, unknown> = {};
  let appCounter = 0;

  const issueConfigToken = () => {
    const refresh = `xoxe-1-${hex(24)}`;
    refreshTokens.add(refresh);
    return refresh;
  };

  const configToken = (context: Context) => {
    if (!context.token || !accessTokens.has(context.token)) {
      throw new SlackError("invalid_auth");
    }
  };

  const appOf = (appId: string | undefined) => {
    const app = appId === undefined ? undefined : apps.get(appId);
    if (!app) throw new SlackError("app_not_found");
    return app;
  };

  const methods: Record<string, (context: Context) => object | null> = {
    "auth.test"(context) {
      if (context.token && accessTokens.has(context.token)) {
        return { team_id: teamId, user_id: userId };
      }
      const app = [...apps.values()].find((candidate) =>
        candidate.botTokens.includes(context.token ?? ""),
      );
      if (!app) return null;
      return {
        team_id: teamId,
        user_id: `U${app.appId}BOT`,
        bot_id: `B${app.appId}`,
        app_id: app.appId,
      };
    },

    "bots.info"(context) {
      const app = [...apps.values()].find((candidate) =>
        candidate.botTokens.includes(context.token ?? ""),
      );
      if (!app) return null;
      if (context.params.bot !== `B${app.appId}`) {
        throw new SlackError("bot_not_found");
      }
      return {
        bot: {
          id: `B${app.appId}`,
          app_id: app.appId,
          user_id: `U${app.appId}BOT`,
          deleted: false,
        },
      };
    },

    "tooling.tokens.rotate"(context) {
      const refresh = context.params.refresh_token ?? "";
      if (!refreshTokens.delete(refresh)) {
        throw new SlackError("invalid_refresh_token");
      }
      const access = `xoxe.xoxp-1-${hex(24)}`;
      accessTokens.add(access);
      const iat = Math.floor(Date.now() / 1000);
      return {
        token: access,
        refresh_token: issueConfigToken(),
        team_id: teamId,
        user_id: userId,
        iat,
        exp: iat + ttl,
      };
    },

    "apps.manifest.create"(context) {
      configToken(context);
      const manifest = JSON.parse(context.params.manifest ?? "null");
      if (manifest === null || typeof manifest !== "object") {
        throw new SlackError("invalid_manifest");
      }
      appCounter += 1;
      const app: FakeSlackApp = {
        appId: `A0FAKE${hex(4).toUpperCase()}${appCounter}`,
        clientId: `${Date.now()}.${appCounter}`,
        clientSecret: hex(16),
        signingSecret: hex(16),
        manifest,
        botTokens: [],
      };
      apps.set(app.appId, app);
      return {
        app_id: app.appId,
        credentials: {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          signing_secret: app.signingSecret,
          verification_token: hex(12),
        },
        oauth_authorize_url: `https://slack.com/oauth/v2/authorize?client_id=${app.clientId}`,
      };
    },

    "apps.manifest.update"(context) {
      configToken(context);
      const app = appOf(context.params.app_id);
      app.manifest = JSON.parse(context.params.manifest ?? "null");
      return {
        app_id: app.appId,
        permissions_updated: false,
        ...manifestUpdateAnswer,
      };
    },

    "apps.manifest.delete"(context) {
      configToken(context);
      apps.delete(appOf(context.params.app_id).appId);
      return {};
    },

    "oauth.v2.access"(context) {
      const pending = codes.get(context.params.code ?? "");
      const scope = scopesOf.get(context.params.code ?? "");
      scopesOf.delete(context.params.code ?? "");
      codes.delete(context.params.code ?? "");
      const app = pending ? apps.get(pending.appId) : undefined;
      if (!pending || !app) throw new SlackError("invalid_code");
      if (
        context.params.client_id !== app.clientId ||
        context.params.client_secret !== app.clientSecret
      ) {
        throw new SlackError("invalid_client_id");
      }
      if (context.params.redirect_uri !== pending.redirectUri) {
        throw new SlackError("bad_redirect_uri");
      }
      const bot = `xoxb-${hex(24)}`;
      app.botTokens.push(bot);
      return {
        access_token: bot,
        token_type: "bot",
        bot_user_id: `U${app.appId}BOT`,
        app_id: app.appId,
        team: { id: teamId, name: "mock" },
        enterprise: null,
        is_enterprise_install: false,
        scope: scope ?? "",
        authed_user: { id: userId },
        ...installAnswer,
      };
    },
  };

  function authorize(authorizeUrl: string) {
    const query = new URL(authorizeUrl).searchParams;
    const app = [...apps.values()].find(
      (candidate) => candidate.clientId === query.get("client_id"),
    );
    const redirectUri = query.get("redirect_uri");
    if (!app || !redirectUri) throw new Error("unknown app or no redirect");
    const code = hex(16);
    codes.set(code, { appId: app.appId, redirectUri });
    scopesOf.set(code, query.get("scope") ?? "");
    return { code, state: query.get("state") };
  }

  async function sendEvent(input: SendSlackEventInput) {
    const app = appOf(input.appId);
    const envelope =
      input.challenge === undefined
        ? slackEventEnvelope({
            appId: app.appId,
            teamId: input.teamId ?? teamId,
            event: input.event ?? {},
            ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
          })
        : { token: hex(12), challenge: input.challenge, type: "url_verification" };
    const body = JSON.stringify(envelope);
    const sentAt = Math.floor(Date.now() / 1000) - (input.ageSeconds ?? 0);
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signSlackRequest(app.signingSecret, body, sentAt),
        ...(input.retryNum === undefined
          ? {}
          : {
              "X-Slack-Retry-Num": String(input.retryNum),
              "X-Slack-Retry-Reason": "http_timeout",
            }),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    let answer: unknown = text;
    try {
      answer = JSON.parse(text);
    } catch {}
    return {
      status: response.status,
      body: answer,
      eventId: "event_id" in envelope ? envelope.event_id : null,
    };
  }

  async function paramsOf(request: Request, url: URL) {
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (request.method !== "POST") return params;
    const type = request.headers.get("content-type") ?? "";
    const text = await request.text();
    if (type.startsWith("application/json")) {
      const body = JSON.parse(text || "{}") as Record<string, unknown>;
      for (const [name, value] of Object.entries(body)) {
        params[name] =
          typeof value === "string" ? value : JSON.stringify(value);
      }
    } else {
      Object.assign(params, Object.fromEntries(new URLSearchParams(text)));
    }
    return params;
  }

  return {
    apps,
    calls,
    issueConfigToken,

    installAnswer,
    manifestUpdateAnswer,
    authorize,
    sendEvent,

    async handle(request) {
      const url = new URL(request.url);
      // The consent screen, answered as an approving admin: the code comes
      // back as JSON instead of a redirect, so curl can drive an install.
      if (
        url.pathname === "/fake/oauth/authorize" &&
        request.method === "GET"
      ) {
        try {
          return Response.json({ ok: true, ...authorize(url.toString()) });
        } catch {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
      }
      if (url.pathname === "/fake/config-tokens" && request.method === "POST") {
        return Response.json({ ok: true, refresh_token: issueConfigToken() });
      }
      // For curl on the local stack: the signature is made in here, from
      // the app's secret, and never leaves it.
      if (url.pathname === "/fake/events" && request.method === "POST") {
        const input = (await request.json()) as {
          url?: unknown;
          app_id?: unknown;
          event?: Record<string, unknown>;
          event_id?: string;
          team_id?: string;
          age_seconds?: number;
          retry_num?: number;
          challenge?: string;
        };
        if (
          typeof input.url !== "string" ||
          !/^https?:\/\//.test(input.url) ||
          typeof input.app_id !== "string" ||
          !apps.has(input.app_id)
        ) {
          return Response.json(
            { ok: false, error: "invalid_request" },
            { status: 400 },
          );
        }
        const sent = await sendEvent({
          url: input.url,
          appId: input.app_id,
          ...(input.event === undefined ? {} : { event: input.event }),
          ...(input.event_id === undefined ? {} : { eventId: input.event_id }),
          ...(input.team_id === undefined ? {} : { teamId: input.team_id }),
          ...(input.age_seconds === undefined
            ? {}
            : { ageSeconds: input.age_seconds }),
          ...(input.retry_num === undefined
            ? {}
            : { retryNum: input.retry_num }),
          ...(input.challenge === undefined
            ? {}
            : { challenge: input.challenge }),
        });
        return Response.json({
          ok: true,
          status: sent.status,
          body: sent.body,
          event_id: sent.eventId,
        });
      }
      const method = url.pathname.startsWith("/api/")
        ? url.pathname.slice("/api/".length)
        : null;
      const run = method === null ? undefined : methods[method];
      if (method === null || run === undefined) return null;
      const authorization = request.headers.get("authorization");
      const context: Context = {
        token: authorization?.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null,
        params: await paramsOf(request, url),
      };
      try {
        const answer = run(context);
        if (answer === null) return null;
        calls.push({ method, ok: true });
        return Response.json({ ok: true, ...answer });
      } catch (error) {
        if (!(error instanceof SlackError)) throw error;
        calls.push({ method, ok: false, error: error.code });
        // Slack answers HTTP 200 with ok:false.
        return Response.json({ ok: false, error: error.code });
      }
    },
  };
}

/** Slack's `v0` signature headers for a body, made with an app's secret. */
export function signSlackRequest(
  signingSecret: string,
  body: string,
  timestampSeconds: number,
): Record<string, string> {
  const timestamp = String(timestampSeconds);
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": signature,
  };
}

/** An `event_callback` envelope as Slack sends it. */
export function slackEventEnvelope(input: {
  appId: string;
  teamId: string;
  event: Record<string, unknown>;
  eventId?: string;
  eventTime?: number;
}) {
  return {
    token: hex(12),
    team_id: input.teamId,
    api_app_id: input.appId,
    event: input.event,
    type: "event_callback",
    event_id: input.eventId ?? `Ev${hex(6).toUpperCase()}`,
    event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
  };
}

/** The Web API fake on its own port: `url` is what SLACK_API_URL takes. */
export function startFakeSlackApi(
  options: Parameters<typeof createFakeSlackWebApi>[0] = {},
) {
  const api = createFakeSlackWebApi(options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const answered = await api.handle(request);
      if (answered) return answered;
      return new URL(request.url).pathname === "/api/auth.test"
        ? Response.json({ ok: false, error: "invalid_auth" })
        : new Response("not found", { status: 404 });
    },
  });
  return {
    ...api,
    url: `http://127.0.0.1:${server.port}/api`,
    stop: () => server.stop(true),
  };
}
