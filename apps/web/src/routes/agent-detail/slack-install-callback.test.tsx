import { describe, expect, test } from "bun:test";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import { apiError, json, me } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();
const CALLBACK = `/agents/${AGENT_ID}/slack/callback?state=state1&error=access_denied`;

describe("Slack install callback", () => {
  for (const [code, message] of [
    ["SLACK_INSTALL_DENIED", "Slack에서 설치를 허용하지 않았습니다."],
    [
      "SLACK_INSTALL_STATE_INVALID",
      "설치 링크가 만료됐거나 이미 사용됐습니다.",
    ],
    [
      "SLACK_INSTALL_REJECTED",
      "Slack 앱이나 워크스페이스가 일치하지 않아 설치하지 못했습니다.",
    ],
  ] as const) {
    test(`shows ${code} once without retrying a spent state`, async () => {
      const { api } = renderAt(CALLBACK, {
        ...agentServer().routes,
        "GET /v1/auth/me": () => json(200, me()),
        "POST /v1/slack/install/complete": () =>
          apiError(409, code, "internal message"),
      });
      await screen.findByText((text) => text.startsWith(message));
      expect(
        screen.getByRole("link", { name: "Slack 앱" }).getAttribute("href"),
      ).toBe(`/agents/${AGENT_ID}?tab=slack`);
      await waitFor(() =>
        expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(
          1,
        ),
      );
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        agent_id: AGENT_ID,
        state: "state1",
        error: "access_denied",
      });
      expect(document.body.textContent).not.toContain("internal message");
    });
  }
  test("shows a processing state until the single completion request answers", async () => {
    let finish = () => {};
    const response = new Promise<Response>((resolve) => {
      finish = () => resolve(apiError(409, "SLACK_INSTALL_DENIED", "denied"));
    });
    const { api } = renderAt(CALLBACK, {
      "GET /v1/auth/me": () => json(200, me()),
      "POST /v1/slack/install/complete": () => response,
    });
    await screen.findByText("준비 중…");
    await waitFor(() =>
      expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(
        1,
      ),
    );
    finish();
    await screen.findByText(/Slack에서 설치를 허용하지 않았습니다/);
  });
});
