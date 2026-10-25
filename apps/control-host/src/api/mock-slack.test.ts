import { afterAll, describe, expect, test } from "bun:test";
import { createSlackBotApi } from "@werft-ai/platform";
import {
  createFakeSlackWebApi,
  startFakeSlackApi,
} from "@werft-ai/testkit/fake-slack-api";
import { startMockSlackOidc } from "@werft-ai/testkit/mock-slack-oidc";

const post = async (
  url: string,
  body: Record<string, string>,
  token?: string,
) =>
  (await (
    await fetch(url, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: new URLSearchParams(body),
    })
  ).json()) as Record<string, unknown>;

describe("fake Slack Web API", () => {
  const slack = startFakeSlackApi({ teamId: "T0X", userId: "U0X" });
  afterAll(() => slack.stop());

  test("a config token rotates once, then the access token makes and installs an app", async () => {
    const refresh = slack.issueConfigToken();
    const rotated = await post(`${slack.url}/tooling.tokens.rotate`, {
      refresh_token: refresh,
    });
    expect(rotated).toMatchObject({ ok: true, team_id: "T0X", user_id: "U0X" });
    expect(
      await post(`${slack.url}/tooling.tokens.rotate`, {
        refresh_token: refresh,
      }),
    ).toEqual({ ok: false, error: "invalid_refresh_token" });

    const access = String(rotated.token);
    expect(await post(`${slack.url}/auth.test`, {}, access)).toMatchObject({
      ok: true,
      user_id: "U0X",
    });
    const created = (await post(
      `${slack.url}/apps.manifest.create`,
      { manifest: JSON.stringify({ display_information: { name: "a" } }) },
      access,
    )) as {
      ok: boolean;
      app_id: string;
      credentials: { client_id: string; client_secret: string };
    };
    expect(created.ok).toBe(true);
    const redirect = "http://127.0.0.1:3000/agents/x/slack/callback";
    const { code } = slack.authorize(
      `https://slack.com/oauth/v2/authorize?${new URLSearchParams({
        client_id: created.credentials.client_id,
        redirect_uri: redirect,
      })}`,
    );
    const installed = await post(`${slack.url}/oauth.v2.access`, {
      code,
      client_id: created.credentials.client_id,
      client_secret: created.credentials.client_secret,
      redirect_uri: redirect,
    });
    expect(installed).toMatchObject({ ok: true, app_id: created.app_id });
    expect(
      await post(`${slack.url}/auth.test`, {}, String(installed.access_token)),
    ).toMatchObject({ ok: true, app_id: created.app_id });
    expect(
      await post(
        `${slack.url}/apps.manifest.create`,
        { manifest: "{}" },
        "not-issued",
      ),
    ).toEqual({ ok: false, error: "invalid_auth" });
  });

  test("channels seeded over HTTP page through conversations.list as the bot sees them", async () => {
    const bot = `xoxb-${crypto.randomUUID()}`;
    slack.apps.set("A0CHANNELS", {
      appId: "A0CHANNELS",
      clientId: "9.9",
      clientSecret: crypto.randomUUID(),
      signingSecret: crypto.randomUUID(),
      manifest: {},
      botTokens: [bot],
    });
    const root = slack.url.replace(/\/api$/, "");
    const seeded = await fetch(`${root}/fake/channels`, {
      method: "POST",
      body: JSON.stringify({
        app_id: "A0CHANNELS",
        channels: [
          { name: "alpha" },
          { name: "beta", is_private: true },
          { name: "gamma", is_private: true, bot_member: true },
          { name: "delta", is_archived: true },
        ],
      }),
    });
    expect(seeded.status).toBe(200);
    expect(
      (
        await fetch(`${root}/fake/channels`, {
          method: "POST",
          body: JSON.stringify({ channels: [{ name: "Bad Name" }] }),
        })
      ).status,
    ).toBe(400);

    const params = {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "2",
    };
    const first = (await post(
      `${slack.url}/conversations.list`,
      params,
      bot,
    )) as {
      channels: { name: string }[];
      response_metadata: { next_cursor: string };
    };
    // Cut at two, then filtered: beta (no bot) leaves a short page.
    expect(first.channels.map((c) => c.name)).toEqual(["alpha"]);
    const second = (await post(
      `${slack.url}/conversations.list`,
      { ...params, cursor: first.response_metadata.next_cursor },
      bot,
    )) as typeof first;
    expect(second.channels).toEqual([
      expect.objectContaining({
        name: "gamma",
        is_private: true,
        is_member: true,
      }),
    ]);
    expect(second.response_metadata.next_cursor).toBe("");
    expect(
      await post(`${slack.url}/conversations.list`, params, "not-issued"),
    ).toEqual({ ok: false, error: "invalid_auth" });

    const limit = (body: object) =>
      fetch(`${root}/fake/rate-limits`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    expect(
      (await limit({ method: "toString", retry_after_seconds: 7 })).status,
    ).toBe(400);
    expect(
      (
        await limit({
          method: "conversations.list",
          retry_after_seconds: 7,
          after: 1,
        })
      ).status,
    ).toBe(200);
    const listed = () =>
      fetch(`${slack.url}/conversations.list`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bot}` },
        body: new URLSearchParams(params),
      });
    expect((await listed()).status).toBe(200);
    const limited = await listed();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("7");
    expect((await listed()).status).toBe(200);
  });

  test("/fake/answers sets a method's next answer once, as text or JSON", async () => {
    const root = slack.url.replace(/\/api$/, "");
    const answer = (body: object) =>
      fetch(`${root}/fake/answers`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    for (const bad of [
      { method: "toString", status: 503, body: "x" },
      { method: "oauth.v2.access", status: 99, body: "x" },
      { method: "oauth.v2.access", status: 503 },
    ]) {
      expect((await answer(bad)).status).toBe(400);
    }
    const exchange = () =>
      fetch(`${slack.url}/oauth.v2.access`, {
        method: "POST",
        body: new URLSearchParams({ code: "none" }),
      });
    expect(
      (await answer({ method: "oauth.v2.access", status: 502, body: "<html>" }))
        .status,
    ).toBe(200);
    const text = await exchange();
    expect([text.status, await text.text()]).toEqual([502, "<html>"]);
    await answer({
      method: "oauth.v2.access",
      status: 200,
      body: { ok: true, token_type: "user" },
    });
    expect(await (await exchange()).json()).toEqual({
      ok: true,
      token_type: "user",
    });
    expect(await (await exchange()).json()).toEqual({
      ok: false,
      error: "invalid_code",
    });
  });

  test("beside the mock IdP, its own bot still answers auth.test", async () => {
    const idp = await startMockSlackOidc({ webApi: createFakeSlackWebApi() });
    try {
      const answer = await post(
        `${idp.listenUrl}/api/auth.test`,
        {},
        "mock-bot-token",
      );
      expect(answer).toMatchObject({ ok: true, user_id: "U0MOCKBOT" });
      const minted = (await (
        await fetch(`${idp.listenUrl}/fake/config-tokens`, { method: "POST" })
      ).json()) as { refresh_token: string };
      expect(
        await post(`${idp.listenUrl}/api/tooling.tokens.rotate`, {
          refresh_token: minted.refresh_token,
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await idp.stop();
    }
  });
});

describe("fake Slack bot calls, through the slack role's client", () => {
  const slack = startFakeSlackApi({ teamId: "T0X" });
  const bot = "fake-bot-credential";
  slack.apps.set("A0BOT", {
    appId: "A0BOT",
    clientId: "1.1",
    clientSecret: "unused",
    signingSecret: "unused",
    manifest: {},
    botTokens: [bot],
  });
  const api = createSlackBotApi({ apiUrl: slack.url });
  afterAll(() => slack.stop());

  test("users.info answers a team member, or the user it was given", async () => {
    expect(await api.userInfo(bot, "U0MEMBER")).toEqual({
      id: "U0MEMBER",
      team_id: "T0X",
      is_restricted: false,
      is_ultra_restricted: false,
    });
    slack.users.set("U0GUEST", { teamId: "T0OTHER", isStranger: true });
    expect(await api.userInfo(bot, "U0GUEST")).toMatchObject({
      team_id: "T0OTHER",
      is_stranger: true,
    });
  });

  test("conversations.info tells a DM, a private and a public channel apart", async () => {
    expect(await api.channelKind(bot, "D0DM")).toBe("dm");
    expect(await api.channelKind(bot, "G0CLOSED")).toBe("private_channel");
    expect(await api.channelKind(bot, "C0OPEN")).toBe("public_channel");
    slack.channels.set("C0GROUP", { isMpim: true });
    expect(await api.channelKind(bot, "C0GROUP")).toBe("private_channel");
  });

  test("the bot joins a public channel itself; a private one only by /fake/invites", async () => {
    const [open, closed, old] = slack.seedChannels([
      { name: "open" },
      { name: "closed", isPrivate: true },
      { name: "old", isArchived: true },
    ]);
    const ids = [open?.id ?? "", closed?.id ?? "", old?.id ?? ""] as const;
    expect(await api.channelMembership(bot, ids[0])).toEqual({
      kind: "public_channel",
      isMember: false,
      isArchived: false,
    });
    await api.joinChannel(bot, ids[0]);
    expect((await api.channelMembership(bot, ids[0])).isMember).toBe(true);
    expect(
      await api.joinChannel(bot, ids[1]).catch((error) => error.code),
    ).toBe("method_not_supported_for_channel_type");
    expect(
      await api.joinChannel(bot, ids[2]).catch((error) => error.code),
    ).toBe("is_archived");

    const root = slack.url.replace(/\/api$/, "");
    const appId = [...slack.apps.values()].find((app) =>
      app.botTokens.includes(bot),
    )?.appId;
    const invite = (channel_id: string) =>
      fetch(`${root}/fake/invites`, {
        method: "POST",
        body: JSON.stringify({ app_id: appId, channel_id }),
      });
    const answered = await invite(ids[1]);
    expect(await answered.json()).toEqual({
      ok: true,
      bot_user_id: `U${appId}BOT`,
    });
    expect((await api.channelMembership(bot, ids[1])).isMember).toBe(true);
    expect((await invite("C0NOWHERE")).status).toBe(400);
  });

  test("setStatus records the thread; a status without a thread, a set failure or another token is refused", async () => {
    await api.setStatus(bot, {
      channelId: "C0OPEN",
      threadTs: "1.000100",
      status: "processing",
    });
    expect(slack.statuses).toEqual([
      { channelId: "C0OPEN", threadTs: "1.000100", status: "processing" },
    ]);
    await expect(
      api.setStatus(bot, { channelId: "C0OPEN", threadTs: "", status: "x" }),
    ).rejects.toMatchObject({ code: "thread_ts_required" });
    await expect(api.userInfo("not-issued", "U0MEMBER")).rejects.toMatchObject({
      code: "invalid_auth",
    });
    slack.failures.set("agents.sessions.setStatus", "not_authorized");
    await expect(
      api.setStatus(bot, {
        channelId: "C0OPEN",
        threadTs: "1.000100",
        status: "processing",
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(slack.statuses).toHaveLength(1);
    expect(
      await (await fetch(slack.url.replace(/\/api$/, "/fake/statuses"))).json(),
    ).toEqual({ ok: true, statuses: slack.statuses });
  });
});
