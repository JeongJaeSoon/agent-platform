import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type MockSlackOidc,
  startMockSlackOidc,
} from "@agent-platform/testkit/mock-slack-oidc";
import {
  exchangeSlackCode,
  SlackOidcConfigError,
  SlackOidcRejectedError,
  SlackOidcUnavailableError,
  slackAuthorizeUrl,
  slackOidcConfigFromEnv,
} from "./slack-link.ts";

const REDIRECT_URI = "https://werft.example/settings/linked-accounts/slack";

describe("slackOidcConfigFromEnv", () => {
  test("off when nothing is set", () => {
    expect(slackOidcConfigFromEnv({})).toBeNull();
  });

  test("defaults the issuer to Slack", () => {
    expect(
      slackOidcConfigFromEnv({
        SLACK_OIDC_CLIENT_ID: "id",
        SLACK_OIDC_CLIENT_SECRET: "secret",
        SLACK_OIDC_REDIRECT_URI: REDIRECT_URI,
      }),
    ).toEqual({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: REDIRECT_URI,
      issuer: "https://slack.com",
    });
  });

  test("a half-set configuration stops the process", () => {
    expect(() =>
      slackOidcConfigFromEnv({ SLACK_OIDC_CLIENT_ID: "id" }),
    ).toThrow(SlackOidcConfigError);
  });

  test("URLs must be absolute http(s)", () => {
    const base = {
      SLACK_OIDC_CLIENT_ID: "id",
      SLACK_OIDC_CLIENT_SECRET: "secret",
    };
    expect(() =>
      slackOidcConfigFromEnv({ ...base, SLACK_OIDC_REDIRECT_URI: "/relative" }),
    ).toThrow(SlackOidcConfigError);
    expect(() =>
      slackOidcConfigFromEnv({
        ...base,
        SLACK_OIDC_REDIRECT_URI: REDIRECT_URI,
        SLACK_OIDC_ISSUER: "ftp://slack.example",
      }),
    ).toThrow(SlackOidcConfigError);
  });
});

describe("exchangeSlackCode", () => {
  let idp: MockSlackOidc;
  const account = { teamId: "T0TEAM", userId: "U0USER" };

  beforeAll(async () => {
    idp = await startMockSlackOidc({ account });
  });
  afterAll(async () => {
    await idp.stop();
  });

  const config = () => ({
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: REDIRECT_URI,
    issuer: idp.url,
  });

  async function codeFor(nonce: string) {
    const url = slackAuthorizeUrl(
      config(),
      { state: "state", nonce, userId: "person" },
      null,
    );
    return (await idp.consent(url)).code;
  }

  test("returns the team and user of a verified id_token", async () => {
    const code = await codeFor("nonce-1");
    expect(await exchangeSlackCode(config(), code, "nonce-1")).toEqual(account);
  });

  test("a nonce from another attempt is rejected", async () => {
    const code = await codeFor("nonce-1");
    await expect(
      exchangeSlackCode(config(), code, "nonce-2"),
    ).rejects.toBeInstanceOf(SlackOidcRejectedError);
  });

  test("a code is good once", async () => {
    const code = await codeFor("nonce-1");
    await exchangeSlackCode(config(), code, "nonce-1");
    await expect(
      exchangeSlackCode(config(), code, "nonce-1"),
    ).rejects.toBeInstanceOf(SlackOidcRejectedError);
  });

  async function codeFrom(other: MockSlackOidc): Promise<string> {
    const url = slackAuthorizeUrl(
      { ...config(), issuer: other.listenUrl },
      { state: "s", nonce: "n", userId: "p" },
      null,
    );
    return (await other.consent(url)).code;
  }

  test("a token signed as another issuer is rejected", async () => {
    const other = await startMockSlackOidc({
      account,
      publicUrl: "https://impostor.example",
    });
    try {
      const code = await codeFrom(other);
      await expect(
        exchangeSlackCode({ ...config(), issuer: other.listenUrl }, code, "n"),
      ).rejects.toThrow(/did not verify/);
    } finally {
      await other.stop();
    }
  });

  test("a token issued to another client is rejected", async () => {
    const other = await startMockSlackOidc({
      account,
      audience: "someone-else",
    });
    try {
      const code = await codeFrom(other);
      await expect(
        exchangeSlackCode({ ...config(), issuer: other.url }, code, "n"),
      ).rejects.toThrow(/did not verify/);
    } finally {
      await other.stop();
    }
  });

  test("an unreachable Slack is unavailable, not a refusal", async () => {
    await expect(
      exchangeSlackCode(
        { ...config(), issuer: "http://127.0.0.1:9" },
        "c",
        "n",
      ),
    ).rejects.toBeInstanceOf(SlackOidcUnavailableError);
  });
});
