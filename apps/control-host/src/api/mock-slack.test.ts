import { afterAll, describe, expect, test } from "bun:test";
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
