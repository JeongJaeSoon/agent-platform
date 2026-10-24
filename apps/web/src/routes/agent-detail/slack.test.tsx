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
  test("does not claim there are no channels when bindings or search failed", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        apiError(403, "FORBIDDEN", "refused"),
      [`GET ${PATH}/slack/channels`]: () =>
        apiError(403, "FORBIDDEN", "refused"),
    });
    const user = await setupUser();
    await screen.findByText("홈 채널");
    await waitFor(() =>
      expect(screen.queryByText("설정 안 됨") === null).toBe(true),
    );
    expect(screen.queryByText("선택 안 됨") === null).toBe(true);
    await user.click(screen.getByRole("tab", { name: "설정" }));
    expect(screen.queryByText("설정 안 됨") === null).toBe(true);
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    await waitFor(() =>
      expect(document.querySelector("[data-slot=field-error]") !== null).toBe(
        true,
      ),
    );
    expect(screen.queryByText("연결된 채널이 없습니다") === null).toBe(true);
    await user.click(screen.getByRole("button", { name: "채널 추가" }));
    expect(
      screen.queryByText(
        "찾은 채널이 없습니다. 비공개 채널은 먼저 /invite로 초대하세요.",
      ) === null,
    ).toBe(true);
  });

  test("explains an empty binding list and omits empty search result borders", async () => {
    renderAt(DETAIL, routes(APP, true));
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    await screen.findByText("연결된 채널이 없습니다");
    expect(screen.queryByRole("list", { name: "연결된 채널" }) === null).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "채널 추가" }));
    await screen.findByText(
      "찾은 채널이 없습니다. 비공개 채널은 먼저 /invite로 초대하세요.",
    );
    expect(
      document.querySelector(
        "[data-slot=dialog-content] [data-slot=row-list]",
      ) === null,
    ).toBe(true);
  });

  test("shows DM immediately but keeps the home placeholder until channel names arrive", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, {
          items: [
            BINDING,
            {
              ...BINDING,
              id: "00000000-0000-4000-8000-000000000002",
              external_surface_id: null,
              surface_kind: "dm",
              home: false,
              mode: "off",
            },
          ],
        }),
      [`GET ${PATH}/slack/channels`]: async () => {
        await gate;
        return json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        });
      },
    });
    try {
      await screen.findByText("홈 채널");
      const status = screen
        .getByRole("heading", { name: "상태" })
        .closest("section") as HTMLElement;
      await waitFor(() =>
        expect(within(status).queryByText("꺼짐") !== null).toBe(true),
      );
      expect(screen.queryByText("채널 ID: C123") === null).toBe(true);
    } finally {
      release();
    }
    await screen.findByText("#general");
  });

  test("includes the visible English home action in its accessible name", async () => {
    renderAt(
      DETAIL,
      {
        ...routes(APP, true),
        [`GET ${PATH}/slack/channels`]: () =>
          json(200, {
            items: [
              {
                id: "C123",
                name: "general",
                is_private: false,
                is_member: true,
              },
            ],
            next_cursor: null,
            stale: false,
            truncated: false,
          }),
      },
      "en",
    );
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "Channels" }));
    await user.click(screen.getByRole("button", { name: "Set home" }));
    expect(
      await screen.findByRole("button", { name: "Set home: #general" }),
    ).toBeDefined();
  });

  test("resolves the overview home from one shared first page", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [BINDING] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            { id: "C123", name: "general", is_private: false, is_member: true },
          ],
          next_cursor: "next",
          stale: false,
          truncated: false,
        }),
    });
    const user = await setupUser();
    const home = await screen.findByText("홈 채널");
    await waitFor(() =>
      expect(home.closest("dl")?.textContent).toContain("#general"),
    );
    await user.click(screen.getByRole("tab", { name: "채널" }));
    expect(
      api.calls.filter((call) => call.path === `${PATH}/slack/channels`),
    ).toHaveLength(1);
  });

  test("labels unresolved bindings as channel IDs without scanning every channel page", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [BINDING] }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            {
              id: "C999",
              name: "another-channel",
              is_private: false,
              is_member: true,
            },
          ],
          next_cursor: "next-page",
          stale: false,
          truncated: false,
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    const list = await screen.findByRole("list", { name: "연결된 채널" });
    expect(await within(list).findByText("채널 ID: C123")).toBeDefined();
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path === `${PATH}/slack/channels`),
      ).toHaveLength(1),
    );
    expect(within(list).queryByText("#C123")).toBeNull();
  });

  test("reads DM and home on the overview and moves keyboard focus to channels", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, {
          items: [
            BINDING,
            {
              ...BINDING,
              id: "00000000-0000-4000-8000-000000000002",
              external_surface_id: null,
              surface_kind: "dm",
              home: false,
              mode: "off",
            },
          ],
        }),
    });
    const user = await setupUser();
    const home = await screen.findByText("홈 채널");
    await waitFor(() =>
      expect(home.closest("dl")?.textContent).toContain("C123"),
    );
    const status = screen
      .getByRole("heading", { name: "상태" })
      .closest("section") as HTMLElement;
    expect(within(status).getByText("꺼짐")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "홈 채널 바꾸기" }));
    expect(
      document.activeElement === screen.getByRole("tab", { name: "채널" }),
    ).toBe(true);
    expect(
      api.calls.filter((call) => call.path === `${PATH}/slack-bindings`),
    ).toHaveLength(1);
  });

  test("shows an ambient binding consistently and keeps it read-only", async () => {
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () =>
        json(200, { items: [{ ...BINDING, mode: "ambient" }] }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    const toggle = await within(
      await screen.findByRole("list", { name: "연결된 채널" }),
    ).findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("항상 반응")).toBeDefined();
    await user.click(toggle);
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  test("changes home from the picker while preserving the channel mode and ceiling", async () => {
    let row = { ...BINDING, home: false, mode: "off" as const };
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
        row = { ...row, home: body.home };
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    await user.click(await screen.findByRole("button", { name: "홈 지정" }));
    await user.click(
      await screen.findByRole("button", { name: "#general 홈 지정" }),
    );
    await screen.findByText("홈 채널을 지정했습니다.");
    await waitFor(() =>
      expect(
        document.activeElement ===
          screen.getByRole("button", { name: "홈 지정" }),
      ).toBe(true),
    );
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      channel_id: "C123",
      mode: "off",
      home: true,
      ceiling: BINDING.ceiling,
    });
  });

  test("applies the current screen's default response to a newly connected channel", async () => {
    let items: (typeof BINDING)[] = [];
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items }),
      [`GET ${PATH}/slack/channels`]: () =>
        json(200, {
          items: [
            {
              id: "C123",
              name: "general",
              is_private: false,
              is_member: false,
            },
          ],
          next_cursor: null,
          stale: false,
          truncated: false,
        }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        const row = { ...BINDING, mode: body.mode, home: body.home };
        items = [row];
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "설정" }));
    await user.click(
      await screen.findByRole("switch", {
        name: "새로 연결할 채널에서 멘션할 때 반응",
      }),
    );
    await user.click(screen.getByRole("tab", { name: "채널" }));
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    expect(await screen.findByText("/invite 필요")).toBeDefined();
    await user.click(
      await screen.findByRole("button", { name: "#general 연결" }),
    );
    await screen.findByText("채널을 연결했습니다.");
    expect(
      api.calls
        .filter((call) => call.method === "PUT")
        .map((call) => call.body),
    ).toEqual([{ channel_id: "C123", mode: "off", home: false }]);
  });

  test("creates the app before requesting installation", async () => {
    const server = agentServer();
    let app: typeof APP | null = null;
    const { api, left } = renderAt(DETAIL, {
      ...routes(),
      [`GET ${PATH}`]: () => {
        const detail = server.detail();
        return json(200, {
          ...detail,
          agent: {
            ...detail.agent,
            active_release_id: `sha256:${"a".repeat(64)}`,
          },
        });
      },
      [`GET ${PATH}/slack/app`]: () => json(200, { slack_app: app }),
      [`POST ${PATH}/slack/app`]: () => {
        app = APP;
        return json(200, { slack_app: APP, created: true, warnings: [] });
      },
      [`POST ${PATH}/slack/install/start`]: () =>
        json(200, {
          authorize_url: "https://slack.com/oauth/v2/authorize",
          expires_at: AT,
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Slack 앱 만들고 설치" }),
    );
    await waitFor(() => expect(left).toHaveLength(1));
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual([`${PATH}/slack/app`, `${PATH}/slack/install/start`]);
  });

  test("revokes an identity after confirmation and focuses the result", async () => {
    let installed = true;
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/identities`]: () =>
        json(200, { items: installed ? [IDENTITY] : [] }),
      [`DELETE ${PATH}/identities/${ID}`]: () => {
        installed = false;
        return json(200, {
          agent_identity: { ...IDENTITY, status: "revoked", revoked_at: AT },
          receipt_id: ID,
        });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "설정" }));
    await user.click(await screen.findByRole("button", { name: "연결 해제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "연결 해제",
      }),
    );
    const result = await screen.findByText("Slack 연결을 해제했습니다.");
    await waitFor(() => expect(document.activeElement === result).toBe(true));
    expect(
      api.calls.some(
        (call) =>
          call.method === "DELETE" && call.path.endsWith(`/identities/${ID}`),
      ),
    ).toBe(true);
  });

  test("saves the DM binding independently of channels", async () => {
    let dm = {
      ...BINDING,
      external_surface_id: null,
      surface_kind: "dm" as const,
      home: false,
      mode: "off" as "off" | "mention",
    };
    const { api } = renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [dm] }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        const body = await request.json();
        dm = { ...dm, mode: body.mode };
        return json(200, { slack_binding: dm, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "설정" }));
    const toggle = await screen.findByRole("switch", {
      name: "다이렉트 메시지",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("false"),
    );
    await user.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(
      await screen.findByText("다이렉트 메시지 설정을 저장했습니다."),
    ).toBeDefined();
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      channel_id: null,
      mode: "mention",
      home: false,
      ceiling: BINDING.ceiling,
    });
  });

  test("merges overlapping channel pages by ID", async () => {
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack/channels`]: (request: Request) => {
        const next = new URL(request.url).searchParams.has("cursor");
        const one = {
          id: "C1",
          name: "one",
          is_private: false,
          is_member: true,
        };
        return json(200, {
          items: next ? [one, { ...one, id: "C2", name: "two" }] : [one],
          next_cursor: next ? null : "page2",
          stale: false,
          truncated: false,
        });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    await screen.findByText("#two");
    expect(screen.getAllByText("#one")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: /#(one|two) 연결/ }),
    ).toHaveLength(2);
  });

  test("clears the previous result for consecutive saves and keeps focus during the request", async () => {
    let row = BINDING;
    let writes = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(DETAIL, {
      ...routes(APP, true),
      [`GET ${PATH}/slack-bindings`]: () => json(200, { items: [row] }),
      [`PUT ${PATH}/slack-bindings`]: async (request: Request) => {
        writes += 1;
        if (writes === 2) await gate;
        if (writes === 3) return apiError(403, "FORBIDDEN", "internal");
        const body = await request.json();
        row = { ...row, mode: body.mode };
        return json(200, { slack_binding: row, receipt_id: ID });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("tab", { name: "채널" }));
    const toggle = await screen.findByRole("switch", {
      name: "채널 ID: C123 멘션할 때 반응",
    });
    toggle.focus();
    await user.keyboard(" ");
    await screen.findByText("채널 반응을 저장했습니다.");
    await user.keyboard(" ");
    try {
      await waitFor(() =>
        expect(screen.queryByText("채널 반응을 저장했습니다.") === null).toBe(
          true,
        ),
      );
      expect(document.activeElement === toggle).toBe(true);
    } finally {
      release();
    }
    await screen.findByText("채널 반응을 저장했습니다.");
    await user.keyboard(" ");
    await screen.findByRole("alert");
    expect(screen.queryByText("채널 반응을 저장했습니다.")).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

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
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
      if (installed) {
        const user = await setupUser();
        await user.click(screen.getByRole("tab", { name: "채널" }));
      }
      expect(screen.getByText(/공개·비공개 채널 모두 \/invite/)).toBeDefined();
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
    await user.click(await screen.findByRole("button", { name: "채널 추가" }));
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
    expect(
      await within(screen.getByRole("region", { name: "Slack 앱" })).findByText(
        "만들기 전",
      ),
    ).toBeDefined();
  });
});
