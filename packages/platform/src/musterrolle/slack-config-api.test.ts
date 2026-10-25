import { describe, expect, test } from "bun:test";
import { createSlackConfigApi, SlackApiError } from "./slack-config-api.ts";

const INPUT = {
  clientId: "9000.1",
  clientSecret: ["fixture", "client", "value"].join("-"),
  code: ["fixture", "grant", "code"].join("-"),
  redirectUri: "https://console.example.ts.net/agents/a/slack/callback",
};

async function failureOf(
  answer: () => Response | Promise<Response>,
  call: (api: ReturnType<typeof createSlackConfigApi>) => Promise<unknown> = (
    api,
  ) => api.exchangeInstallCode(INPUT),
) {
  const api = createSlackConfigApi({
    apiUrl: "http://slack.invalid/api",
    fetch: (async () => answer()) as unknown as typeof fetch,
  });
  const error = await call(api).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SlackApiError)) throw new Error("no SlackApiError");
  for (const value of [INPUT.clientSecret, INPUT.code]) {
    expect(error.message).not.toContain(value);
    expect(error.code).not.toContain(value);
  }
  return {
    method: error.method,
    failure: error.failure,
    httpStatus: error.httpStatus,
    code: error.code,
    answered: error.answered,
  };
}

describe("how an oauth.v2.access call failed", () => {
  test("no answer is unreachable, with no status", async () => {
    expect(
      await failureOf(() => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({
      method: "oauth.v2.access",
      failure: "unreachable",
      httpStatus: null,
      code: "unreachable",
      answered: false,
    });
  });

  test("a non-JSON 5xx is http_status with that status", async () => {
    expect(
      await failureOf(
        () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      ),
    ).toMatchObject({
      failure: "http_status",
      httpStatus: 502,
      code: "http_502",
      answered: false,
    });
  });

  test("ok:false is Slack's error code, answered unless the status is 5xx", async () => {
    expect(
      await failureOf(() =>
        Response.json({ ok: false, error: "invalid_code" }),
      ),
    ).toMatchObject({
      failure: "slack_error",
      httpStatus: 200,
      code: "invalid_code",
      answered: true,
    });
    expect(
      await failureOf(() =>
        Response.json({ ok: false, error: "internal_error" }, { status: 503 }),
      ),
    ).toMatchObject({
      failure: "slack_error",
      httpStatus: 503,
      code: "internal_error",
      answered: false,
    });
  });

  test("Slack's own error is slack_error even when it reads like one of ours", async () => {
    for (const reserved of ["timeout", "unreachable", "unexpected_answer"]) {
      expect(
        await failureOf(() => Response.json({ ok: false, error: reserved })),
      ).toMatchObject({ failure: "slack_error", code: reserved });
    }
  });

  test("ok:false with no readable error is http_status", async () => {
    expect(
      await failureOf(() =>
        Response.json({ ok: false, error: "Not A Code" }, { status: 503 }),
      ),
    ).toMatchObject({
      failure: "http_status",
      httpStatus: 503,
      code: "http_503",
      answered: false,
    });
  });

  test("a 429 is Slack's ratelimited, answered", async () => {
    expect(
      await failureOf(
        () =>
          new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
      ),
    ).toMatchObject({
      failure: "slack_error",
      httpStatus: 429,
      code: "ratelimited",
      answered: true,
    });
  });

  test("the bot check names auth.test when it fails", async () => {
    expect(
      await failureOf(
        () => new Response("<html>", { status: 502 }),
        (api) => api.botIdentity(INPUT.code),
      ),
    ).toMatchObject({
      method: "auth.test",
      failure: "http_status",
      httpStatus: 502,
    });
  });

  test("an ok:true answer that does not parse is unexpected_answer, without its body", async () => {
    expect(
      await failureOf(() =>
        Response.json({
          ok: true,
          access_token: INPUT.code,
          token_type: "user",
          scope: "",
          app_id: "A0APP",
        }),
      ),
    ).toEqual({
      method: "oauth.v2.access",
      failure: "unexpected_answer",
      httpStatus: 200,
      code: "unexpected_answer",
      answered: false,
    });
  });
});
