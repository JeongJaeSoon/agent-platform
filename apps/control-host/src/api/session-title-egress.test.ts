import { describe, expect, test } from "bun:test";
import { sessionTitleEgressUrlFromEnv } from "./egress-authorizer.ts";

describe("sessionTitleEgressUrlFromEnv", () => {
  test("unset or empty turns generated titles off", () => {
    expect(sessionTitleEgressUrlFromEnv({})).toBeNull();
    expect(
      sessionTitleEgressUrlFromEnv({ SESSION_TITLE_EGRESS_URL: "" }),
    ).toBeNull();
  });

  test("an http URL is taken as given", () => {
    expect(
      sessionTitleEgressUrlFromEnv({
        SESSION_TITLE_EGRESS_URL: "http://egress-proxy:3129",
      }),
    ).toBe("http://egress-proxy:3129/");
  });

  test("anything else stops the start", () => {
    expect(() =>
      sessionTitleEgressUrlFromEnv({ SESSION_TITLE_EGRESS_URL: "egress:3129" }),
    ).toThrow("not an http(s) URL");
  });
});
