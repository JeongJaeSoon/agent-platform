import { describe, expect, test } from "bun:test";
import { json, me, memberMe, WORKSPACE_ID } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const harness = await appHarness();
const { screen, within } = harness;

const APPS = `/v1/workspaces/${WORKSPACE_ID}/slack/apps`;
const AGENT_ID = "019a0000-0000-7000-8000-0000000000c1";
const NO_SECRET = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
};

function app(
  kind: "agent" | "link",
  state: "creating" | "created" | "deleting",
  appId: string | null,
) {
  return {
    id: crypto.randomUUID(),
    kind,
    agent_id: kind === "agent" ? AGENT_ID : null,
    state,
    app_id: appId,
    client_id: appId === null ? null : "1000.1",
    redirect_url: "https://console.example.test/callback",
    created_by_token_user: "U0ISSUER",
    created_at: "2026-10-01T00:20:00.000Z",
    updated_at: "2026-10-23T12:48:00.000Z",
    secrets: {
      slack_signing_secret: NO_SECRET,
      slack_client_secret: NO_SECRET,
      slack_bot_token: NO_SECRET,
    },
  };
}
const agent = (installed: boolean, name = "Release Notes") => ({
  id: AGENT_ID,
  name,
  slug: "release-notes",
  installed,
});

describe("자동으로 만든 앱", () => {
  test("소유자는 계정 연결 앱과 에이전트 앱을 상태와 함께 본다", async () => {
    harness.renderAt("/settings/workspace/slack-apps", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APPS}`]: () =>
        json(200, {
          items: [
            { slack_app: app("link", "created", "A07LINK000"), agent: null },
            {
              slack_app: app("agent", "created", "A07PLACEHLD"),
              agent: agent(true),
            },
            {
              slack_app: app("agent", "created", "A07SECOND1"),
              agent: agent(false, "Draft"),
            },
            {
              slack_app: app("agent", "creating", null),
              agent: agent(false, "Pending"),
            },
          ],
        }),
    });

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);

    const link = within(rows[0] as HTMLElement);
    expect(link.getByText("계정 연결 앱")).toBeTruthy();
    expect(link.getByText("A07LINK000")).toBeTruthy();
    expect(link.getByText("연결됨")).toBeTruthy();
    expect(link.getByText("Sign in with Slack")).toBeTruthy();
    expect(link.queryByRole("link")).toBeNull();

    const installed = within(rows[1] as HTMLElement);
    expect(installed.getByText("Release Notes 앱")).toBeTruthy();
    expect(installed.getByText("연결됨")).toBeTruthy();
    expect(installed.getByText("@release-notes")).toBeTruthy();
    expect(
      installed
        .getByRole("link", { name: "Release Notes" })
        .getAttribute("href"),
    ).toBe(`/agents/${AGENT_ID}`);
    expect(
      installed
        .getByRole("link", { name: /^자세히\s?: Release Notes 앱$/ })
        .getAttribute("href"),
    ).toBe(`/agents/${AGENT_ID}?tab=slack`);

    expect(within(rows[2] as HTMLElement).getByText("설치 전")).toBeTruthy();
    const creating = within(rows[3] as HTMLElement);
    expect(creating.getByText("만드는 중")).toBeTruthy();
    expect(creating.getByText("앱 ID 없음")).toBeTruthy();
  });

  test("만든 앱이 없으면 빈 상태를 보인다", async () => {
    harness.renderAt("/settings/workspace/slack-apps", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${APPS}`]: () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText("이 콘솔이 만든 Slack 앱이 아직 없습니다."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("설정 메뉴에 소유자에게만 항목이 있고, 구성원은 목록을 부르지 않는다", async () => {
    const calls: string[] = [];
    harness.renderAt("/settings/workspace/slack-apps", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET ${APPS}`]: () => {
        calls.push(APPS);
        return json(200, { items: [] });
      },
    });
    expect(await screen.findByText(/워크스페이스 설정 변경/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "자동으로 만든 앱" })).toBeNull();
    expect(calls).toEqual([]);
  });
});
