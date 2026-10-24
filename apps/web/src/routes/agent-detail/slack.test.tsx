import { describe, expect, test } from "bun:test";
import type { components } from "@werft-ai/client";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  WORKSPACE_ID,
} from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
const PATH = `/v1/agents/${AGENT_ID}`;
const DETAIL = `/agents/${AGENT_ID}?tab=slack`;
const ID = "00000000-0000-4000-8000-000000000001";
const AT = "2026-10-24T00:00:00.000Z";
const summary = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
};
const APP: NonNullable<
  components["schemas"]["GetSlackAppResponse"]["slack_app"]
> = {
  id: ID,
  kind: "agent",
  agent_id: AGENT_ID,
  state: "created",
  app_id: "A123",
  client_id: "123",
  redirect_url: `https://console.test/agents/${AGENT_ID}/slack/callback`,
  created_by_token_user: "U123",
  created_at: AT,
  updated_at: AT,
  secrets: {
    slack_signing_secret: summary,
    slack_client_secret: summary,
    slack_bot_token: summary,
  },
};
const IDENTITY: components["schemas"]["ListAgentIdentitiesResponse"]["items"][number] =
  {
    id: ID,
    agent_id: AGENT_ID,
    provider: "slack_bot",
    app_id: "A123",
    team_id: "T123",
    bot_user_id: "U123",
    credential_ref: "slack/bot",
    status: "active",
    revision: 0,
    created_by: null,
    created_at: AT,
    revoked_at: null,
  };
const BINDING: components["schemas"]["ListSlackBindingsResponse"]["items"][number] =
  {
    id: ID,
    workspace_id: WORKSPACE_ID,
    owner_id: WORKSPACE_ID,
    surface: "slack",
    installation_id: ID,
    external_surface_id: "C123",
    surface_kind: "public_channel",
    agent_id: AGENT_ID,
    mode: "mention",
    ceiling: { actions: ["session.read"], disclosure: "summary" },
    home: true,
    memory_write_policy: "deny",
    status: "ready",
    muted: false,
    revision: 0,
    created_at: AT,
    revoked_at: null,
  };
function routes(app: typeof APP | null = null, installed = false) {
  return {
    ...agentServer().routes,
    "GET /v1/auth/me": () => json(200, me()),
    [`GET ${PATH}/slack/app`]: () => json(200, { slack_app: app }),
    [`GET ${PATH}/identities`]: () =>
      json(200, { items: installed ? [IDENTITY] : [] }),
    [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [] }),
    [`GET ${PATH}/slack/channels`]: () =>
      json(200, {
        items: [],
        next_cursor: null,
        stale: false,
        truncated: false,
      }),
  };
}

describe("Slack management", () => {
  for (const [label, app, installed] of [
    ["만들기 전", null, false],
    ["설치 대기", APP, false],
    ["연결됨", APP, true],
    [
      "재설치 필요",
      {
        ...APP,
        secrets: {
          ...APP.secrets,
          slack_bot_token: { ...summary, configured: true },
        },
      },
      false,
    ],
  ] as const) {
    test(`shows ${label} from API state`, async () => {
      renderAt(DETAIL, routes(app, installed));
      expect(await screen.findByText(label)).toBeDefined();
      expect(screen.getByText(/공개 채널은 서버가 자동 참여/)).toBeDefined();
    });
  }
  test("does not load Slack endpoints from the overview tab", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}`, routes());
    await screen.findByRole("tab", { name: "Slack" });
    expect(api.calls.some((call) => call.path.includes("/slack"))).toBe(false);
  });
  test("starts an existing app installation and leaves through app services", async () => {
    const { left, api } = renderAt(DETAIL, {
      ...routes(APP),
      [`POST ${PATH}/slack/install/start`]: () =>
        json(200, {
          authorize_url: "https://slack.com/oauth/v2/authorize",
          expires_at: AT,
        }),
    });
    const user = await setupUser();
    const button = await screen.findByRole("button", { name: "Slack 앱 설치" });
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(left).toEqual(["https://slack.com/oauth/v2/authorize"]),
    );
    expect(
      api.calls.some(
        (call) => call.method === "POST" && call.path === `${PATH}/slack/app`,
      ),
    ).toBe(false);
  });
  test("shows 403 and withholds installation", async () => {
    renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}/slack/app`]: () =>
        apiError(403, "FORBIDDEN", "internal description"),
    });
    expect(await screen.findByText("오류")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Slack 앱 만들고 설치" }),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("internal description");
  });
  test("keeps the saved ceiling and home when switching mention off with the keyboard", async () => {
    let row = BINDING;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [row] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        row = { ...row, mode: body.mode };
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    const toggle = await screen.findByRole("switch", {
      name: "#general 멘션할 때 반응",
    });
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      channel_id: "C123",
      mode: "off",
      home: true,
      ceiling: BINDING.ceiling,
    });
    expect(await screen.findByText("채널 반응을 저장했습니다.")).toBeDefined();
  });
  test("debounces a search and passes the page cursor with the same query", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/channels`]: (request: Request) => {
        const url = new URL(request.url);
        const q = url.searchParams.get("q");
        return json(200, {
          items: [
            {
              id: url.searchParams.has("cursor") ? "C2" : "C1",
              name: q || "general",
              is_private: true,
              is_member: true,
            },
          ],
          next_cursor:
            q === "dev" && !url.searchParams.has("cursor") ? "page2" : null,
          stale: false,
          truncated: false,
        });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    await user.type(await screen.findByLabelText("채널 찾기"), "dev");
    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.search.includes("cursor=page2")),
      ).toBe(true),
    );
    const searches = api.calls.filter((call) =>
      call.path.includes("/slack/channels"),
    );
    expect(
      searches.filter((call) => call.search.includes("q=dev")).length,
    ).toBe(2);
    expect(
      searches.some((call) => /q=d(&|$)|q=de(&|$)/.test(call.search)),
    ).toBe(false);
  });
  test("requires confirmation before deleting an app", async () => {
    let app: typeof APP | null = APP;
    const { api } = renderAt(DETAIL, {
      ...routes(APP),
      [`GET ${PATH}/slack/app`]: () => json(200, { slack_app: app }),
      [`DELETE /v1/workspaces/${WORKSPACE_ID}/slack/apps/${ID}`]: () => {
        app = null;
        return json(200, { slack_app: { ...APP, state: "deleted" } });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "앱 삭제" }));
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "앱 삭제",
      }),
    );
    expect(await screen.findByText("Slack 앱을 삭제했습니다.")).toBeDefined();
    expect(await screen.findByText("만들기 전")).toBeDefined();
  });
});
