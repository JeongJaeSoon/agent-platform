import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { focusManager, onlineManager } from "@tanstack/react-query";
import type { ApiError } from "@werft-ai/client";
import {
  agentDetailSchema,
  CREDENTIAL_REVOKE_NOTICE,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { queryKeys } from "../api/queries.ts";
import { type Locale, translate } from "../i18n/i18n.tsx";
import { AGENT_ID, agentServer, CARD } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
} from "../test-support/fake-api.ts";
import { fakeIntersection } from "../test-support/intersection.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, cleanup, render, renderAt, screen, waitFor, within } =
  await appHarness();
// Over happy-dom's, which setupDom put in place.
const viewport = fakeIntersection();
afterEach(() => viewport.show(() => true));
afterAll(() => viewport.restore());
// After the DOM exists: Radix picks a no-op layout effect when loaded before
// it, and its dialogs then never reach the page.
const { agentRefusal } = await import("./agents.tsx");
const { createBrowserHistory } = await import("@tanstack/react-router");
const { App } = await import("../app.tsx");
const { createServices } = await import("../services.tsx");
const { fakeApi } = await import("../test-support/fake-api.ts");
const { WAITING_SESSIONS } = await import("../test-support/render-app.tsx");

/**
 * The app on a browser history over the window's own history, so back is a
 * popstate and history.state survives; a reload is a new app reading it.
 */
function openInBrowser(path: string, routes: Parameters<typeof fakeApi>[0]) {
  window.history.replaceState(null, "", path);
  const api = fakeApi({
    [WAITING_SESSIONS]: () => json(200, { items: [], next_cursor: null }),
    ...routes,
  });
  const services = createServices({
    baseUrl: "https://console.test",
    fetch: api.fetch,
    validate: "strict",
    leave: () => {},
  });
  const open = () => {
    const history = createBrowserHistory();
    const view = render(
      <App services={services} history={history} locale="ko" />,
    );
    return () => {
      view.unmount();
      history.destroy();
    };
  };
  let close = open();
  return {
    api,
    reload: () => {
      close();
      close = open();
    },
  };
}

const stepsInState = () =>
  (
    (window.history.state as Record<string, unknown> | null)?.[
      "new-agent.histories"
    ] as { step: string }[] | undefined
  )?.map(({ step }) => step);
type User = Awaited<ReturnType<typeof setupUser>>;
type Api = ReturnType<typeof renderAt>["api"];

const currentStep = () =>
  screen
    .getByRole("navigation", { name: "에이전트 만들기 단계" })
    .querySelector('[aria-current="step"]')?.textContent;
const STEP_NO = {
  이름: 1,
  "하는 일": 2,
  "배포 판": 3,
  켜기: 4,
  "채널 연결": 5,
} as const;
const atStep = (label: keyof typeof STEP_NO) =>
  waitFor(() => expect(currentStep()).toBe(`${STEP_NO[label]}${label}`));
const posted = (api: Api, path: string) =>
  api.calls.find((c) => c.method === "POST" && c.path === path)?.body;

async function toJobStep(user: User) {
  await user.type(await screen.findByLabelText("이름"), "결제 담당");
  await user.type(screen.getByLabelText("식별자"), "billing");
  await user.click(screen.getByRole("button", { name: "다음" }));
  await atStep("하는 일");
}

async function fillJob(user: User) {
  await user.type(screen.getByLabelText("역할"), CARD.role);
  await user.type(screen.getByLabelText("지시 사항"), CARD.instructions);
  await user.selectOptions(await screen.findByLabelText("모델"), CARD.model);
  await user.click(screen.getByRole("button", { name: "초안 저장하고 다음" }));
}

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;
const CARD_TAB = `${DETAIL}?tab=card`;
const RELEASE_TAB = `${DETAIL}?tab=release`;
const PROFILE = "claude-coding-local";
const showTab = async (user: User, name: string) =>
  user.click(await screen.findByRole("tab", { name }));
const showList = async (user: User, name: string) =>
  user.click(await screen.findByRole("button", { name }));
// The state badge of the card or row an agent's name links from.
const stateOf = (link: HTMLElement) =>
  link.closest("tr, [data-slot=card]")?.querySelector("[data-state]");
const showTable = async (user: User) =>
  user.click(await screen.findByRole("button", { name: "표" }));

async function seedRelease(server: ReturnType<typeof agentServer>) {
  const handler = server.routes[`POST /v1/agents/${AGENT_ID}/releases`];
  const versionId = server.versions.at(-1)?.id ?? "";
  await handler?.(
    new Request("https://console.test/", {
      method: "POST",
      body: JSON.stringify({
        version_id: versionId,
        runtime_profile_id: PROFILE,
      }),
    }),
  );
}

describe("agentRefusal", () => {
  const refusal = (locale: Locale, code: string, message: string) =>
    agentRefusal(
      (key, vars) => translate(locale, key, vars),
      { code, message, status: 422 } as ApiError,
      "owner",
    );

  test("모델 불일치는 공백이 든 모델 이름도 원문 없이 옮긴다", () => {
    const message =
      "card.model: model custom model is not the model of runtime profile claude-coding-local";
    expect(refusal("ko", "UNSUPPORTED_CAPABILITY", message)).toBe(
      "카드 모델 custom model이(가) 프로필 claude-coding-local의 모델과 달라 release를 만들지 못했습니다. 카드 모델과 같은 모델의 프로필을 고르세요.",
    );
    expect(refusal("en", "UNSUPPORTED_CAPABILITY", message)).toBe(
      "The card's model custom model is not the model of profile claude-coding-local, so no release was created. Choose a profile that runs the card's model.",
    );
  });

  test("다른 거부는 지금처럼 이유 뒤에 서버 설명을 붙인다", () => {
    const tools =
      "card.capabilities.tools: runtime profile claude-coding-local does not allow WebFetch";
    expect(refusal("ko", "UNSUPPORTED_CAPABILITY", tools)).toBe(
      `${translate("ko", "error.UNSUPPORTED_CAPABILITY")} ${tools}`,
    );
    expect(refusal("ko", "BAD_REQUEST", "card.model: required")).toBe(
      `${translate("ko", "error.BAD_REQUEST")} card.model: required`,
    );
  });
});

describe("에이전트 목록", () => {
  beforeEach(() => localStorage.clear());

  test("목록과 상태를 카드로 보이고, 표로 바꿔도 상세로 잇는다", async () => {
    const server = agentServer();
    renderAt("/agents", { ...meOk, ...server.routes });
    const card = (
      await screen.findByRole("link", { name: "결제 담당" })
    ).closest("[data-slot=card]") as HTMLElement;
    expect(within(card).getByText("초안")).toBeDefined();
    expect(card.textContent).toContain("식별자 billing");
    expect(
      within(card)
        .getByRole("link", { name: "결제 담당 자세히" })
        .getAttribute("href"),
    ).toBe(DETAIL);

    await showTable(await setupUser());
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(link.getAttribute("href")).toBe(DETAIL);
    const row = link.closest("tr") as HTMLElement;
    expect(within(row).getByText("초안")).toBeDefined();
    expect(row.textContent).toContain("식별자 billing");
  });

  test("배지는 초안·활성·일시정지·보관됨을 서로 다르게 보인다", async () => {
    const base = agentServer().detail().agent;
    const agent = (
      name: string,
      status: "active" | "paused" | "archived",
      released: boolean,
    ) => ({
      ...base,
      id: crypto.randomUUID(),
      slug: name,
      name,
      status,
      active_release_id: released ? crypto.randomUUID() : null,
      activation_revision: released ? 0 : -1,
    });
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () =>
        json(200, {
          items: [
            agent("draft", "active", false),
            agent("live", "active", true),
            agent("held", "paused", true),
            agent("old", "archived", false),
          ],
          next_cursor: null,
        }),
    });
    const badges = () =>
      ["draft", "live", "held", "old"].map((name) => {
        const badge = stateOf(screen.getByRole("link", { name }));
        return [badge?.textContent, badge?.getAttribute("data-state")];
      });
    const expected = [
      ["초안", "draft"],
      ["활성", "active"],
      ["일시정지", "paused"],
      ["보관됨", "archived"],
    ];
    await screen.findByRole("link", { name: "draft" });
    await waitFor(() => expect(badges()).toEqual(expected));
    await showTable(await setupUser());
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "draft" }).closest("tr"),
      ).not.toBeNull(),
    );
    expect(badges()).toEqual(expected);
    // Only the archived row takes the inactive tone; its badge still says so.
    expect(
      ["draft", "live", "held", "old"].map((name) =>
        screen
          .getByRole("link", { name })
          .closest("tr")
          ?.hasAttribute("data-inactive"),
      ),
    ).toEqual([false, false, false, true]);
  });

  test("구성원은 전체 목록 대신 안내를 보고, 새 에이전트는 만들 수 있다", async () => {
    const { history } = renderAt("/agents", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/agents": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText(/전체 에이전트 목록은 소유자와 관리자만 봅니다/),
    ).toBeDefined();
    // Whoever may create is offered it once, at the head of the list.
    const [button, ...others] = screen.getAllByRole("button", {
      name: "새 에이전트",
    });
    expect(others).toEqual([]);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("agent.manage");
    expect(document.body.textContent).not.toContain("does not hold");
    const user = await setupUser();
    await user.click(button as HTMLElement);
    await waitFor(() => expect(history.location.pathname).toBe("/agents/new"));
  });

  test("agent.create가 없으면 새 에이전트 버튼을 끈 채 말로 된 이유를 적는다", async () => {
    const none = { ...memberMe(), permissions: [] };
    renderAt("/agents", {
      "GET /v1/auth/me": () => json(200, none),
      "GET /v1/agents": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    const button = await screen.findByRole("button", { name: "새 에이전트" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("에이전트 만들기 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.");
  });

  test("영어 화면도 권한 식별자와 서버 문구 없이 안내한다", async () => {
    renderAt(
      "/agents",
      {
        "GET /v1/auth/me": () => json(200, memberMe()),
        "GET /v1/agents": () =>
          apiError(
            403,
            "FORBIDDEN",
            "This principal does not hold agent.manage",
          ),
        "GET /v1/administered-agents": () => json(200, { items: [] }),
      },
      "en",
    );
    expect(
      await screen.findByText(/Only owners and admins see every agent/),
    ).toBeDefined();
    expect(document.body.textContent).not.toContain("agent.manage");
    expect(document.body.textContent).not.toContain("does not hold");
  });
});

describe("에이전트 카드", () => {
  beforeEach(() => localStorage.clear());

  /** One released agent whose card asks for two credentials, one bound. */
  function releasedServer() {
    const server = agentServer();
    const base = server.detail();
    const version = base.versions[0];
    if (!version) throw new Error("agentServer has a first version");
    const card = {
      ...version.card,
      capabilities: {
        ...version.card.capabilities,
        mcp: [{ server: "linear" }],
        credential_refs: ["github", "linear"],
      },
    };
    const release = {
      id: crypto.randomUUID(),
      agent_id: AGENT_ID,
      version_id: version.id,
      card_sha256: "0".repeat(64),
      runtime_profile_id: PROFILE,
      profile_digest: "digest-1",
      runtime_config_snapshot: {},
      effective_tools: { tools: ["Read"], mcp: [] },
      policy_pins: {},
      created_by: USER_ID,
      created_at: "2026-10-11T01:00:00.000Z",
      approved_by: null,
      approved_at: null,
    };
    const agent = { ...base.agent, active_release_id: release.id };
    const detail = agentDetailSchema.parse({
      ...base,
      agent,
      versions: [{ ...version, card }],
      releases: [release],
      active_release: release,
    });
    return {
      ...server.routes,
      "GET /v1/agents": () => json(200, { items: [agent], next_cursor: null }),
      [`GET /v1/agents/${AGENT_ID}`]: () => json(200, detail),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(200, {
          users: [
            {
              user_id: USER_ID,
              email: "owner@example.com",
              display_name: "Owner",
              created_by: null,
              created_at: "2026-10-11T00:00:00.000Z",
            },
          ],
          teams: [],
        }),
      [`GET /v1/agents/${AGENT_ID}/credential-bindings`]: () =>
        json(200, {
          items: [
            {
              id: crypto.randomUUID(),
              agent_id: AGENT_ID,
              credential_ref: "github",
              bound_by: USER_ID,
              bound_at: "2026-10-11T00:00:00.000Z",
              revoked_at: null,
              running_sessions: 0,
            },
          ],
          revoke_notice: CREDENTIAL_REVOKE_NOTICE,
        }),
    };
  }

  const cardFor = async (name: string) =>
    (await screen.findByRole("link", { name })).closest(
      "[data-slot=card]",
    ) as HTMLElement;
  const fact = (card: HTMLElement, term: string) =>
    [...card.querySelectorAll("dt")].find((dt) => dt.textContent === term)
      ?.nextElementSibling?.textContent;

  test("배포 판·역할·지시 사항·실행 프로필·MCP·자격 증명·관리자를 카드에 모은다", async () => {
    renderAt("/agents", { ...meOk, ...releasedServer() });
    const card = await cardFor("결제 담당");
    await waitFor(() => expect(card.textContent).toContain("v1 배포됨"));
    expect(card.textContent).toContain(CARD.role);
    expect(card.textContent).toContain(CARD.instructions);
    expect(fact(card, "실행 프로필")).toBe(PROFILE);
    expect(fact(card, "MCP")).toBe("linear");
    expect(fact(card, "자격 증명")).toBe("연결 필요 1개");
    expect(card.textContent).toContain("관리자 Owner");
  });

  test("API에 없는 답변 대기·스킬은 값을 지어내지 않고 미계측이라 적는다", async () => {
    renderAt("/agents", { ...meOk, ...releasedServer() });
    const card = await cardFor("결제 담당");
    await waitFor(() => expect(card.textContent).toContain("v1 배포됨"));
    expect(fact(card, "답변 대기")).toBe("미계측");
    expect(fact(card, "스킬")).toBe("미계측");
  });

  test("추가 정보를 못 불러와도 카드는 이름·상태와 상세 링크를 지킨다", async () => {
    const server = agentServer();
    const refuse = () => apiError(503, "UNAVAILABLE", "down");
    renderAt("/agents", {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: refuse,
      [`GET /v1/agents/${AGENT_ID}/admins`]: refuse,
      [`GET /v1/agents/${AGENT_ID}/credential-bindings`]: refuse,
    });
    const card = await cardFor("결제 담당");
    await waitFor(() =>
      expect(fact(card, "실행 프로필")).toBe("—불러오지 못함"),
    );
    expect(stateOf(card.querySelector("a") as HTMLElement)?.textContent).toBe(
      "초안",
    );
    expect(
      within(card).getByRole("link", { name: "결제 담당 자세히" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("카드 내용을 못 불러오면 지시 사항·자격 증명 칸도 비우지 않고 그렇다고 적는다", async () => {
    const routes = releasedServer();
    renderAt("/agents", {
      ...meOk,
      ...routes,
      [`GET /v1/agents/${AGENT_ID}`]: () =>
        apiError(503, "UNAVAILABLE", "down"),
    });
    const card = await cardFor("결제 담당");
    await waitFor(() => expect(fact(card, "자격 증명")).toBe("—불러오지 못함"));
    expect(card.textContent).toContain("지시 사항—불러오지 못함");
  });

  test("카드 내용이 늦으면 자격 증명 칸은 연결 목록이 먼저 와도 기다린다", async () => {
    renderAt("/agents", {
      ...meOk,
      ...releasedServer(),
      [`GET /v1/agents/${AGENT_ID}`]: () => new Promise<Response>(() => {}),
    });
    const card = await cardFor("결제 담당");
    await waitFor(() =>
      expect(fact(card, "관리자") ?? card.textContent).toContain("Owner"),
    );
    const cell = [...card.querySelectorAll("dt")].find(
      (dt) => dt.textContent === "자격 증명",
    )?.nextElementSibling;
    expect(cell?.querySelector("[aria-busy=true]")).not.toBeNull();
  });

  describe("보이는 카드만", () => {
    const items = (count: number) => {
      const base = agentServer().detail().agent;
      return Array.from({ length: count }, (_, n) => ({
        ...base,
        id: crypto.randomUUID(),
        slug: `agent-${n}`,
        name: `에이전트 ${n}`,
      }));
    };
    const slugOf = (element: Element) =>
      element.querySelector("[data-agent]")?.getAttribute("data-agent");
    const detailCalls = (api: { calls: readonly { path: string }[] }) =>
      api.calls
        .map((c) => c.path)
        .filter((path) => /^\/v1\/agents\/[^/]+/.test(path));

    test("화면에 들어온 카드만 추가 정보를 부르고, 스크롤로 들어오면 그때 부른다", async () => {
      const agents = items(14);
      const first = new Set(agents.slice(0, 6).map((agent) => agent.slug));
      viewport.show((element) => first.has(slugOf(element) ?? ""));
      const { api } = renderAt("/agents", {
        ...meOk,
        "GET /v1/agents": () => json(200, { items: agents, next_cursor: null }),
      });
      const late = await cardFor("에이전트 13");
      await waitFor(() => expect(detailCalls(api).length).toBe(18));
      const asked = new Set(
        detailCalls(api).map(
          (path) => /^\/v1\/agents\/([^/]+)/.exec(path)?.[1],
        ),
      );
      expect(asked.has(agents[5]?.id)).toBe(true);
      expect(asked.has(agents[6]?.id)).toBe(false);
      // Not yet read is a placeholder, never the dash of a failed read.
      const profile = [...late.querySelectorAll("dt")].find(
        (dt) => dt.textContent === "실행 프로필",
      )?.nextElementSibling;
      expect(profile?.querySelector("[aria-busy=true]")).not.toBeNull();
      expect(screen.queryByText(/자세한 정보를 불러옵니다/)).toBeNull();

      act(() => viewport.show(() => true));
      await waitFor(() => expect(detailCalls(api).length).toBe(42));
      // Each card's three reads go out once, however often it is reported.
      expect(new Set(detailCalls(api)).size).toBe(42);
      act(() => viewport.show(() => true));
      await waitFor(() =>
        expect(profile?.querySelector("[aria-busy=true]")).toBeNull(),
      );
      expect(detailCalls(api).length).toBe(42);
    });

    test("창이나 네트워크로 돌아와도 이미 불러온 카드를 다시 부르지 않는다", async () => {
      const { api } = renderAt("/agents", { ...meOk, ...releasedServer() });
      const card = await cardFor("결제 담당");
      await waitFor(() => expect(card.textContent).toContain("관리자 Owner"));
      await waitFor(() => expect(detailCalls(api).length).toBe(3));
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      // Let a refetch, if any, go out before counting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(detailCalls(api).length).toBe(3);
      focusManager.setFocused(undefined);
    });
  });
});

describe("에이전트 목록 탭과 보기", () => {
  beforeEach(() => localStorage.clear());

  test("에이전트가 없어도 탭과 보기 전환은 남고 전체 탭이 비었다고 알린다", async () => {
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: [], next_cursor: null }),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(await screen.findByRole("button", { name: "전체 0" })).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "관리하는 에이전트 0" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "카드" })).toBeDefined();
    expect(screen.getByText("아직 에이전트가 없습니다.")).toBeDefined();
  });

  test("관리하는 에이전트 탭은 개수와 그 목록만 보인다", async () => {
    const server = agentServer();
    const other = {
      ...server.detail().agent,
      id: crypto.randomUUID(),
      slug: "other",
      name: "다른 에이전트",
    };
    renderAt("/agents", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents": () =>
        json(200, { items: [server.detail().agent, other], next_cursor: null }),
      "GET /v1/administered-agents": () =>
        json(200, { items: [server.detail().agent] }),
    });
    expect(
      (await screen.findByRole("button", { name: "전체 2" })).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    const user = await setupUser();
    await showList(user, "관리하는 에이전트 1");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "다른 에이전트" })).toBeNull(),
    );
    expect(screen.getByRole("link", { name: "결제 담당" })).toBeDefined();
  });

  test("검색은 이름·식별자로 목록만 좁히고 개수는 서버 값 그대로 둔다", async () => {
    // The page has other live regions (the waiting bell); this one is the
    // list's own.
    const results = () =>
      document.querySelector("main output") as HTMLOutputElement;
    const server = agentServer();
    const other = {
      ...server.detail().agent,
      id: crypto.randomUUID(),
      slug: "refund-desk",
      name: "다른 에이전트",
    };
    renderAt("/agents", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents": () =>
        json(200, { items: [server.detail().agent, other], next_cursor: null }),
      "GET /v1/administered-agents": () => json(200, { items: [other] }),
    });
    const all = await screen.findByRole("button", { name: "전체 2" });
    const search = screen.getByRole("searchbox", {
      name: "이름이나 식별자로 찾기",
    });
    const cards = screen.getByRole("button", { name: "카드" });
    // Categories, then view, then search: the toolbar's reading order.
    expect(
      all.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      cards.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const user = await setupUser();
    // Empty until someone types, then the match count for a screen reader.
    expect(results().textContent).toBe("");
    await user.type(search, "  REFUND ");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "결제 담당" })).toBeNull(),
    );
    expect(results().textContent).toBe("1개 표시");
    expect(screen.getByRole("link", { name: "다른 에이전트" })).toBeDefined();
    expect(screen.getByRole("button", { name: "전체 2" })).toBeDefined();

    const region = results();
    await showList(user, "관리하는 에이전트 1");
    expect(
      await screen.findByRole("link", { name: "다른 에이전트" }),
    ).toBeDefined();
    // The same live region across categories, so the new count is heard.
    expect(results() === region).toBe(true);
    expect(results().textContent).toBe("1개 표시");

    await user.clear(search);
    await user.type(search, "없는 이름");
    expect(
      await screen.findByText("검색어에 맞는 에이전트가 없습니다"),
    ).toBeDefined();
    expect(results().textContent).toBe("0개 표시");
    await user.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect(
      await screen.findByRole("link", { name: "다른 에이전트" }),
    ).toBeDefined();
    expect((search as HTMLInputElement).value).toBe("");
    expect(document.activeElement === search).toBe(true);
  });

  test("관리하는 에이전트가 서버 상한만큼 오면 개수에 +를 붙이고 일부만 보인다고 알린다", async () => {
    const base = agentServer().detail().agent;
    const items = Array.from({ length: 200 }, (_, n) => ({
      ...base,
      id: crypto.randomUUID(),
      slug: `agent-${n}`,
      name: `에이전트 ${n}`,
    }));
    // Only the tab and its notice matter here, not 200 cards' details.
    viewport.show(() => false);
    renderAt("/agents", {
      ...meOk,
      "GET /v1/agents": () => json(200, { items: [base], next_cursor: null }),
      "GET /v1/administered-agents": () => json(200, { items }),
    });
    await showList(await setupUser(), "관리하는 에이전트 200+");
    expect(await screen.findByText("처음 200개만 보입니다.")).toBeDefined();
  });

  test("보기 선택은 사용자마다 브라우저에 남고 처음은 카드다", async () => {
    const server = agentServer();
    // Another person's choice in the same browser is not this one's.
    localStorage.setItem("ap.agents.view.someone-else", "table");
    renderAt("/agents", { ...meOk, ...server.routes });
    const cards = await screen.findByRole("button", { name: "카드" });
    expect(cards.getAttribute("aria-pressed")).toBe("true");
    await showTable(await setupUser());
    expect(localStorage.getItem(`ap.agents.view.${USER_ID}`)).toBe("table");
    cleanup();

    renderAt("/agents", { ...meOk, ...server.routes });
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(link.closest("tr")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "표" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("목록을 볼 수 없는 구성원", () => {
  const member = {
    "GET /v1/auth/me": () => json(200, memberMe()),
    "GET /v1/agents": () =>
      apiError(403, "FORBIDDEN", "This principal does not hold agent.manage"),
  };

  test("관리자로 지정된 에이전트는 목록 안내 아래에서 상세로 잇는다", async () => {
    const agent = agentServer().detail().agent;
    renderAt("/agents", {
      ...member,
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
    });
    const section = (
      await screen.findByRole("heading", { name: "내가 관리하는 에이전트" })
    ).closest("section") as HTMLElement;
    expect(
      within(section)
        .getByRole("link", { name: "결제 담당" })
        .getAttribute("href"),
    ).toBe(DETAIL);
    expect(
      screen.getByText(/전체 에이전트 목록은 소유자와 관리자만 봅니다/),
    ).toBeDefined();
  });

  test("관리하는 에이전트가 없으면 없다고 적는다", async () => {
    renderAt("/agents", {
      ...member,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText("아직 관리자로 지정된 에이전트가 없습니다."),
    ).toBeDefined();
  });
});

describe("찾을 수 없는 에이전트", () => {
  test.each([
    ["없는 id(404)", me(), 404, "NOT_FOUND", "Agent not found"],
    [
      "볼 수 없는 구성원(403)",
      memberMe(),
      403,
      "FORBIDDEN",
      "This principal does not hold agent.manage",
    ],
  ] as const)(
    "%s는 제목과 목록 링크가 있는 찾을 수 없음 화면이다",
    async (_label, who, status, code, message) => {
      renderAt("/agents/missing", {
        "GET /v1/auth/me": () => json(200, who),
        "GET /v1/agents/missing": () => apiError(status, code, message),
      });
      expect(
        await screen.findByRole("heading", {
          name: "에이전트를 찾을 수 없습니다",
        }),
      ).toBeDefined();
      expect(
        screen
          .getByRole("link", { name: "에이전트 목록으로" })
          .getAttribute("href"),
      ).toBe("/agents");
      expect(document.body.textContent).not.toContain(message);
      expect(screen.queryByText("이 화면을 볼 권한이 없습니다")).toBeNull();
    },
  );
});

describe("새 에이전트", () => {
  test("이름부터 채널 연결까지 만들고 Slack 연결은 나중에 할 수 있다", async () => {
    const server = agentServer();
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}/slack/app`]: () =>
        json(200, {
          slack_app: null,
          event_url: null,
          events: { state: "pending", checked_at: null },
        }),
      [`GET /v1/agents/${AGENT_ID}/identities`]: () => json(200, { items: [] }),
    });
    const user = await setupUser();
    await atStep("이름");
    await user.type(screen.getByLabelText("이름"), "결제 담당");
    await user.type(screen.getByLabelText("식별자"), "billing");
    await user.click(screen.getByRole("button", { name: "다음" }));

    await atStep("하는 일");
    expect(
      screen.getByRole("button", { name: /^이름\s*, 완료$/ }),
    ).toBeDefined();
    expect((screen.getByLabelText("역할") as HTMLInputElement).value).toBe("");
    await user.type(screen.getByLabelText("역할"), CARD.role);
    await user.type(screen.getByLabelText("지시 사항"), CARD.instructions);
    const model = screen.getByLabelText("모델") as HTMLSelectElement;
    expect(model.getAttribute("data-slot")).toBe("native-select");
    expect(model.value).toBe("");
    expect([...model.options].map((option) => option.textContent)).toEqual([
      "모델을 고르세요",
      "claude-haiku-5",
      "claude-sonnet-5",
    ]);
    await user.selectOptions(model, CARD.model);
    await user.type(screen.getByLabelText("금지 도구"), "Bash{Enter}Write");
    await user.click(
      screen.getByRole("button", { name: "초안 저장하고 다음" }),
    );

    await atStep("배포 판");
    expect(posted(api, "/v1/agents")).toEqual({
      slug: "billing",
      name: "결제 담당",
      card: {
        ...CARD,
        capabilities: { tools: null, mcp: null, forbidden: ["Bash", "Write"] },
      },
    });
    // The profile that runs the card's model is offered first.
    const profile = (await screen.findByLabelText(
      "프로필",
    )) as HTMLSelectElement;
    expect(profile.value).toBe(PROFILE);
    await user.click(screen.getByRole("button", { name: "배포 판 만들기" }));

    await atStep("켜기");
    expect(posted(api, `/v1/agents/${AGENT_ID}/releases`)).toEqual({
      version_id: server.versions[0]?.id,
      runtime_profile_id: PROFILE,
    });
    await user.click(screen.getByRole("button", { name: "에이전트 켜기" }));
    await atStep("채널 연결");
    expect(await screen.findByText(/결제 담당을\(를\) 켰습니다/)).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Slack 앱 만들고 설치" }),
    ).toBeDefined();
    expect(posted(api, `/v1/agents/${AGENT_ID}/activate`)).toEqual({
      release_id: server.releases[0]?.id,
      expected_revision: -1,
    });
    expect(
      screen.getByRole("link", { name: "나중에 하기" }).getAttribute("href"),
    ).toBe(DETAIL);
  });

  test("식별자는 이름에서 채워지고, 고친 뒤에는 이름을 따라가지 않는다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const name = (await screen.findByLabelText("이름")) as HTMLInputElement;
    const slug = screen.getByLabelText("식별자") as HTMLInputElement;
    await user.type(name, "Refund Desk 2");
    expect(slug.value).toBe("refund-desk-2");
    await user.clear(slug);
    await user.type(slug, "refunds");
    await user.type(name, "b");
    expect(slug.value).toBe("refunds");
  });

  test("영문이 없는 이름은 식별자를 비워 두고, 빈 칸은 다음으로 넘기지 않는다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "결제 담당");
    const slug = screen.getByLabelText("식별자") as HTMLInputElement;
    expect(slug.value).toBe("");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(slug.getAttribute("aria-invalid")).toBe("true"));
    expect(currentStep()).toBe("1이름");
  });

  test("하는 일 칸이 비면 칸마다 이유를 보이고 아무것도 저장하지 않는다", async () => {
    const { api } = renderAt("/agents/new", {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.click(
      screen.getByRole("button", { name: "초안 저장하고 다음" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("역할").getAttribute("aria-invalid")).toBe(
        "true",
      ),
    );
    expect(
      screen.getByLabelText("지시 사항").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    expect(currentStep()).toBe("2하는 일");
  });

  test("하는 일까지 마치고 나가도 에이전트는 목록에 초안으로 남는다", async () => {
    const server = agentServer();
    let saved = false;
    const { history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
      "GET /v1/agents": () =>
        json(200, {
          items: saved ? [server.detail().agent] : [],
          next_cursor: null,
        }),
      "POST /v1/agents": (request: Request) => {
        saved = true;
        return server.routes["POST /v1/agents"](request);
      },
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("배포 판");

    await user.click(screen.getByRole("link", { name: "나중에 하기" }));
    await waitFor(() => expect(history.location.pathname).toBe(DETAIL));
    act(() => history.push("/agents"));
    const link = await screen.findByRole("link", { name: "결제 담당" });
    expect(stateOf(link)?.textContent).toBe("초안");
  });

  test("초안을 다시 저장해도 다른 곳에서 넣은 말투는 글자 그대로 남는다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("배포 판");
    const first = server.versions[0] as (typeof server.versions)[number];
    server.versions.push({
      ...first,
      id: "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b",
      version_no: 2,
      card: { ...first.card, tone: " 공손하게 " },
    });

    act(() => history.back());
    await atStep("하는 일");
    await user.type(screen.getByLabelText("지시 사항"), " 더.");
    await user.click(
      screen.getByRole("button", { name: "초안 저장하고 다음" }),
    );
    await atStep("배포 판");
    const patch = api.calls.find((c) => c.method === "PATCH");
    const card = (patch?.body as { card: { tone?: string } }).card;
    expect(card.tone).toBe(" 공손하게 ");
  });

  test("초안을 저장한 뒤 뒤로 가서 고치면 새로 만들지 않고 그 초안을 고친다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("배포 판");
    // Past the save the stepper does not lead back.
    expect(
      (
        screen.getByRole("button", {
          name: /^하는 일\s*, 완료$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    act(() => history.back());
    await atStep("하는 일");
    await user.type(screen.getByLabelText("지시 사항"), " 더.");
    await user.click(
      screen.getByRole("button", { name: "초안 저장하고 다음" }),
    );
    await atStep("배포 판");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(
      (patch?.body as { card: { instructions: string } }).card.instructions,
    ).toBe(`${CARD.instructions} 더.`);
    // The release is made from the version this save produced.
    await user.click(
      await screen.findByRole("button", { name: "배포 판 만들기" }),
    );
    await atStep("켜기");
    expect(
      (posted(api, `/v1/agents/${AGENT_ID}/releases`) as { version_id: string })
        .version_id,
    ).toBe(server.versions[1]?.id ?? "missing");

    act(() => history.go(-3));
    await atStep("이름");
    expect((screen.getByLabelText("식별자") as HTMLInputElement).readOnly).toBe(
      true,
    );
  });

  test("나갔다가 뒤로 돌아와도 그 초안을 이어서 고치고 새로 만들지 않는다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("배포 판");

    // Leaving unmounts the flow; coming back mounts a new one.
    await user.click(screen.getByRole("link", { name: "나중에 하기" }));
    await waitFor(() => expect(history.location.pathname).toBe(DETAIL));
    act(() => history.back());
    await atStep("배포 판");
    act(() => history.back());
    await atStep("하는 일");
    expect((screen.getByLabelText("역할") as HTMLInputElement).value).toBe(
      CARD.role,
    );
    await user.type(screen.getByLabelText("지시 사항"), " 더.");
    await user.click(
      screen.getByRole("button", { name: "초안 저장하고 다음" }),
    );
    await atStep("배포 판");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(true);
    // The release goes to the version that save made, not the first one.
    await user.click(
      await screen.findByRole("button", { name: "배포 판 만들기" }),
    );
    await atStep("켜기");
    expect(
      (posted(api, `/v1/agents/${AGENT_ID}/releases`) as { version_id: string })
        .version_id,
    ).toBe(server.versions[1]?.id ?? "missing");
  });

  test("첫 단계에서 나갔다 돌아와도 그 초안의 이름·식별자를 이어 간다", async () => {
    const server = agentServer();
    const { api, history } = renderAt("/agents/new", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    await atStep("배포 판");

    act(() => history.go(-2));
    await atStep("이름");
    act(() => history.push("/agents"));
    await screen.findByRole("link", { name: "결제 담당" });
    act(() => history.back());
    await atStep("이름");
    const slug = screen.getByLabelText("식별자") as HTMLInputElement;
    expect(slug.value).toBe("billing");
    expect(slug.readOnly).toBe(true);
    expect((screen.getByLabelText("이름") as HTMLInputElement).value).toBe(
      "결제 담당",
    );
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    expect((screen.getByLabelText("역할") as HTMLInputElement).value).toBe(
      CARD.role,
    );
    await user.click(
      screen.getByRole("button", { name: "초안 저장하고 다음" }),
    );
    await atStep("배포 판");
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
  });

  test("Stepper로 앞 단계에 돌아가면 그 단계 제목이 포커스를 받는다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await toJobStep(user);
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("하는 일"),
    );
    await user.click(screen.getByRole("button", { name: /^이름\s*, 완료$/ }));
    await atStep("이름");
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    expect(document.activeElement?.textContent).toBe("이름");
  });

  test("거부된 초안 저장은 서버 이유를 한 줄로 보이고 그 단계에 머문다", async () => {
    renderAt("/agents/new", {
      ...meOk,
      ...agentServer().routes,
      "POST /v1/agents": () =>
        apiError(409, "ALREADY_EXISTS", "slug billing is taken"),
    });
    const user = await setupUser();
    await toJobStep(user);
    await fillJob(user);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 식별자는 다른 에이전트가 이미 씁니다. '이름' 단계로 돌아가 식별자를 바꾸세요.",
    );
    expect(currentStep()).toBe("2하는 일");
  });

  test("모델 목록을 읽는 동안과 못 읽었을 때는 이유를 보이고 만들지 못하게 한다", async () => {
    let fail: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      fail = resolve;
    });
    renderAt("/agents/new", {
      ...meOk,
      ...agentServer().routes,
      "GET /v1/profiles": async () => {
        await gate;
        return apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "The catalog cannot be read",
        );
      },
    });
    await toJobStep(await setupUser());
    const create = () =>
      screen.getByRole("button", {
        name: "초안 저장하고 다음",
      }) as HTMLButtonElement;
    expect(await screen.findByText(/모델 목록을 불러오는 중/)).toBeDefined();
    expect(create().disabled).toBe(true);
    fail();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "모델 목록을 불러오지 못해 저장할 수 없습니다",
    );
    expect(screen.queryByLabelText("모델")).toBeNull();
    expect(create().disabled).toBe(true);
  });
});

describe("에이전트 상세", () => {
  test("카드를 고치면 새 version으로 저장했다고 하고, 두 version의 차이를 보인다", async () => {
    const server = agentServer();
    const { api } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "환불 문의에도 답한다.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        /저장했습니다 — version 2\. 아직 활성화되지 않았습니다/,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe("환불 문의에도 답한다.");
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.headers.get("idempotency-key")).toBeNull();
    expect((patch?.body as { card: unknown }).card).toEqual({
      ...CARD,
      instructions: "환불 문의에도 답한다.",
    });
    const diff = await screen.findByText("version 1 → version 2");
    const figure = diff.closest("figure") as HTMLElement;
    expect(
      figure.querySelector('[data-kind="removed"]')?.textContent,
    ).toContain("결제 문의에 답한다.");
    expect(figure.querySelector('[data-kind="added"]')?.textContent).toContain(
      "환불 문의에도 답한다.",
    );
  });

  test("이미 있는 version과 같은 카드로 저장하면 그 version을 저장 결과로 본다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "환불 문의에도 답한다.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다 — version 2/);
    await user.clear(screen.getByLabelText("지시 사항"));
    await user.type(screen.getByLabelText("지시 사항"), CARD.instructions);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "저장했습니다. 같은 카드가 이미 있어(version 1) 새 version은 생기지 않았습니다.",
      ),
    ).toBeDefined();
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe(CARD.instructions);
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
    await showTab(user, "배포");
    const release = screen
      .getByRole("heading", { name: "release" })
      .closest("section") as HTMLElement;
    expect(
      (within(release).getByLabelText("version") as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe("version 1");
  });

  test("저장 결과는 보낸 카드 전체(정규화, rules 포함)로 찾는다", async () => {
    const server = agentServer();
    const rule = (id: string) => ({
      id,
      text: `규칙 ${id}`,
      source: "user" as const,
    });
    const base = server.versions[0] as (typeof server.versions)[number];
    server.versions.splice(
      0,
      1,
      { ...base, card: { ...CARD, rules: [rule("x")] } },
      {
        ...base,
        id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
        version_no: 2,
        card: { ...CARD, rules: [rule("y")] },
        content_sha256: "2".repeat(64),
      },
      {
        ...base,
        id: "8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a",
        version_no: 3,
        card: { ...CARD, instructions: "다른 지시.", rules: [rule("x")] },
        content_sha256: "3".repeat(64),
      },
    );
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, CARD.instructions);
    await user.type(screen.getByLabelText("모델"), "  ");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "저장했습니다. 같은 카드가 이미 있어(version 1) 새 version은 생기지 않았습니다.",
      ),
    ).toBeDefined();
  });

  test("바뀐 것 없이 저장하면 새 version이 없다고 말한다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "저장했습니다. 카드 내용이 같아 새 version은 생기지 않았습니다.",
      ),
    ).toBeDefined();
  });

  test("release를 만들고 활성화한다: 저장·release·활성화는 서로 다른 문구다", async () => {
    const server = agentServer();
    const { api } = renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const profile = (await screen.findByLabelText(
      "프로필",
    )) as HTMLSelectElement;
    // With no release yet the form offers the profile running the card's model.
    expect(profile.value).toBe(PROFILE);
    await user.selectOptions(profile, "claude-coding-fast");
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Unknown runtime profile claude-coding-fast",
    );
    await user.selectOptions(profile, PROFILE);
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    expect(
      await screen.findByText(
        "release를 만들었습니다(version 1). 아직 활성화되지 않았습니다.",
      ),
    ).toBeDefined();
    await user.click(
      await screen.findByRole("button", {
        name: `version 1 · ${PROFILE} 활성화`,
      }),
    );
    expect(
      await screen.findByText(
        `활성화됐습니다 — 이제 새 세션은 version 1 · ${PROFILE}(으)로 시작합니다.`,
      ),
    ).toBeDefined();
    const activate = api.calls.find((c) => c.path.endsWith("/activate"));
    expect(activate?.body).toEqual({
      release_id: server.releases[0]?.id,
      expected_revision: -1,
    });
    // The overview panel stays mounted behind the release tab.
    const glance = screen.getByRole("list", {
      name: "에이전트 현황",
      hidden: true,
    });
    await waitFor(() =>
      expect(glance.firstElementChild?.textContent).toContain(
        `version 1실행 프로필 ${PROFILE}`,
      ),
    );
    expect(agentDetailSchema.safeParse(server.detail()).success).toBe(true);
  });
  test("결과는 버튼을 누른 섹션에 나오고 포커스가 그리로 간다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const section = (name: string) =>
      screen.getByRole("heading", { name }).closest("section") as HTMLElement;
    await user.click(await screen.findByRole("button", { name: "저장" }));
    const saved = await screen.findByText(/저장했습니다/);
    expect(section("카드").contains(saved)).toBe(true);
    expect(document.activeElement?.contains(saved)).toBe(true);

    await showTab(user, "배포");
    await screen.findByLabelText("프로필");
    await user.selectOptions(
      screen.getByLabelText("프로필"),
      "claude-coding-fast",
    );
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    const refused = await screen.findByRole("alert");
    expect(section("release").contains(refused)).toBe(true);
    expect(document.activeElement?.contains(refused)).toBe(true);
    // One result at a time: the card's notice went away with the new action.
    expect(screen.queryByText(/저장했습니다/)).toBeNull();

    await user.selectOptions(screen.getByLabelText("프로필"), PROFILE);
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    await user.click(
      await screen.findByRole("button", {
        name: `version 1 · ${PROFILE} 활성화`,
      }),
    );
    const activated = await screen.findByText(/활성화됐습니다/);
    expect(section("release").contains(activated)).toBe(true);
    expect(document.activeElement?.contains(activated)).toBe(true);
  });

  test("새 version을 저장하면 release 폼도 그 version을 고른다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "환불 문의에도 답한다.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다 — version 2/);
    // The summary panel offers the same move; this is the one by the result.
    await user.click(
      within(screen.getByRole("tabpanel")).getByRole("button", {
        name: "배포 탭으로",
      }),
    );
    expect(
      screen.getByRole("tab", { name: "배포", selected: true }),
    ).toBeDefined();
    const release = screen
      .getByRole("heading", { name: "release" })
      .closest("section") as HTMLElement;
    await waitFor(() =>
      expect(
        (within(release).getByLabelText("version") as HTMLSelectElement)
          .selectedOptions[0]?.textContent,
      ).toBe("version 2"),
    );
  });
});

describe("두 탭 동시 활성화", () => {
  test("늦은 탭은 덮어쓰지 않고(409) 재조회와 차이를 안내한 뒤에야 다시 활성화한다", async () => {
    const server = agentServer();
    await seedRelease(server);
    server.versions.push({
      ...(server.versions[0] as (typeof server.versions)[number]),
      id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      version_no: 2,
      card: { ...CARD, instructions: "환불도 맡는다." },
      content_sha256: "f".repeat(64),
    });
    await seedRelease(server);
    const [first, second] = server.releases;
    const label = (no: number) => `version ${no} · ${PROFILE}`;

    const tabA = renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const tabB = renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const a = within(tabA.container);
    const b = within(tabB.container);
    const user = await setupUser();
    const activateB = await b.findByRole("button", {
      name: `${label(2)} 활성화`,
    });
    await user.click(
      await a.findByRole("button", { name: `${label(1)} 활성화` }),
    );
    expect(await a.findByText(/활성화됐습니다/)).toBeDefined();

    await user.click(activateB);
    const conflict = await b.findByText(
      "다른 곳에서 활성 release를 먼저 바꿨습니다",
    );
    const panel = conflict.closest("section") as HTMLElement;
    expect(panel.textContent).toContain("덮어쓰지 않고 멈췄습니다");
    // The refusal shows by the button that caused it and takes focus.
    expect(
      b
        .getByRole("heading", { name: "release" })
        .closest("section")
        ?.contains(panel),
    ).toBe(true);
    expect(document.activeElement?.contains(panel)).toBe(true);
    expect(b.queryByText(/활성화됐습니다/)).toBeNull();
    const fromB = tabB.api.calls.filter((c) => c.path.endsWith("/activate"));
    expect(fromB).toHaveLength(1);
    expect(fromB[0]?.body).toEqual({
      release_id: second?.id,
      expected_revision: -1,
    });

    await user.click(
      within(panel).getByRole("button", { name: "최신 상태 불러오기" }),
    );
    expect(
      await b.findByText(
        `보던 화면의 활성 release: 없음. 지금 활성 release: ${label(1)}. 아래 차이를 확인하고 필요하면 다시 활성화하세요.`,
      ),
    ).toBeDefined();
    expect(b.getByText(`없음 → ${label(1)}`)).toBeDefined();

    await user.click(b.getByRole("button", { name: `${label(2)} 활성화` }));
    expect(await b.findByText(/활성화됐습니다/)).toBeDefined();
    const retry = tabB.api.calls.filter((c) => c.path.endsWith("/activate"));
    expect(retry.at(-1)?.body).toEqual({
      release_id: second?.id,
      expected_revision: 0,
    });
    expect(server.detail().agent.active_release_id).toBe(second?.id ?? "");
    expect(first).toBeDefined();
  });
});

describe("편집 중 다른 곳의 저장", () => {
  function otherTabSaves(server: ReturnType<typeof agentServer>) {
    server.versions.push({
      ...(server.versions[0] as (typeof server.versions)[number]),
      id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      version_no: 2,
      card: { ...CARD, instructions: "다른 탭이 고친 지시." },
      content_sha256: "e".repeat(64),
    });
  }

  test("고치던 내용은 재조회로 사라지지 않고, 최신이 생겼다고 알린 뒤 원할 때만 불러온다", async () => {
    const server = agentServer();
    const { services } = renderAt(CARD_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "내가 고치던 지시.");
    otherTabSaves(server);
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    expect(
      await screen.findByText(
        "다른 곳에서 카드를 저장해 최신이 version 2입니다. 고치던 내용은 그대로 두었습니다. 이대로 저장하면 이 내용이 다음 version이 됩니다.",
      ),
    ).toBeDefined();
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe("내가 고치던 지시.");
    await user.click(
      screen.getByRole("button", { name: "최신 카드 불러오기" }),
    );
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe("다른 탭이 고친 지시.");
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });

  test("release 폼은 적어 둔 profile을 지키면서 새 version을 기본으로 고른다", async () => {
    const server = agentServer();
    const { services } = renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    await user.selectOptions(await screen.findByLabelText("프로필"), PROFILE);
    otherTabSaves(server);
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    const release = screen
      .getByRole("heading", { name: "release" })
      .closest("section") as HTMLElement;
    await waitFor(() =>
      expect(
        (within(release).getByLabelText("version") as HTMLSelectElement)
          .selectedOptions[0]?.textContent,
      ).toBe("version 2"),
    );
    expect(
      (within(release).getByLabelText("프로필") as HTMLSelectElement).value,
    ).toBe(PROFILE);
  });

  test("release 폼의 profile은 목록에서 모델 이름과 함께 고르고, 직전 release의 profile을 기본으로 둔다", async () => {
    const server = agentServer();
    await seedRelease(server);
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const select = (await screen.findByLabelText(
      "프로필",
    )) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "claude-coding-fast · claude-haiku-5 · 카드 모델과 다름",
      "claude-coding-local · claude-sonnet-5",
    ]);
    expect(select.value).toBe(PROFILE);
  });

  test("모델과 profile 안내는 정확 일치 규칙을 말하고 내부 파일 이름을 보이지 않는다", async () => {
    const server = agentServer();
    renderAt(DETAIL, { ...meOk, ...server.routes });
    const described = async (label: string) =>
      (
        (await screen.findByLabelText(label)).getAttribute(
          "aria-describedby",
        ) ?? ""
      )
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(await described("모델")).toContain(
      "release할 때 고르는 프로필의 모델과 정확히 같아야 합니다",
    );
    expect(await described("프로필")).toBe(
      "각 프로필과 그 프로필이 쓰는 모델. 카드 모델과 같은 모델의 프로필만 release할 수 있습니다 프로필의 권한 모드는 아직 이 화면에 나오지 않습니다.",
    );
    expect(document.body.textContent).not.toContain("profiles.yaml");
  });

  test("카드 모델과 다른 profile로 거부된 release는 영어 원문 없이 한국어로 알린다", async () => {
    const server = agentServer();
    renderAt(RELEASE_TAB, {
      ...meOk,
      ...server.routes,
      [`POST /v1/agents/${AGENT_ID}/releases`]: () =>
        apiError(
          422,
          "UNSUPPORTED_CAPABILITY",
          "card.model: model claude-sonnet-5 is not the model of runtime profile claude-coding-fast",
        ),
    });
    const user = await setupUser();
    await user.selectOptions(
      await screen.findByLabelText("프로필"),
      "claude-coding-fast",
    );
    await user.click(screen.getByRole("button", { name: "release 만들기" }));
    const refusal = await screen.findByText(/release를 만들지 못했습니다/);
    expect(refusal.textContent).toBe(
      "카드 모델 claude-sonnet-5이(가) 프로필 claude-coding-fast의 모델과 달라 release를 만들지 못했습니다. 카드 모델과 같은 모델의 프로필을 고르세요.",
    );
    expect(document.body.textContent).not.toContain("is not the model of");
  });

  test("profile 목록을 못 읽으면 이유를 보이고 release를 만들지 못하게 한다", async () => {
    const server = agentServer();
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      "GET /v1/profiles": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "The catalog cannot be read"),
    });
    const user = await setupUser();
    const shown = async (name: string, alert: string, button: string) => {
      await showTab(user, name);
      expect(
        (await screen.findAllByRole("alert")).map((a) => a.textContent),
      ).toContainEqual(expect.stringContaining(alert));
      expect(
        (screen.getByRole("button", { name: button }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    };
    await shown("카드", "모델 목록을 불러오지 못해 저장할 수 없습니다", "저장");
    await shown("배포", "프로필 목록을 불러오지 못했습니다", "release 만들기");
    expect(screen.queryByLabelText("프로필")).toBeNull();
    expect(screen.queryByLabelText("모델")).toBeNull();
  });

  test("카탈로그에 없는 카드 모델은 '카탈로그에 없음'으로 남고, 손대지 않으면 그대로 저장한다", async () => {
    const server = agentServer();
    const legacy = (body: ReturnType<typeof server.detail>) => ({
      ...body,
      versions: body.versions.map((v) => ({
        ...v,
        card: { ...v.card, model: "claude-legacy-4" },
      })),
    });
    const { api } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: () => json(200, legacy(server.detail())),
      [`PATCH /v1/agents/${AGENT_ID}`]: () =>
        json(200, legacy(server.detail())),
    });
    const user = await setupUser();
    const model = (await screen.findByLabelText("모델")) as HTMLSelectElement;
    expect(model.getAttribute("data-slot")).toBe("native-select");
    expect(model.value).toBe("claude-legacy-4");
    expect(model.selectedOptions[0]?.textContent).toBe(
      "claude-legacy-4 · 카탈로그에 없음",
    );
    const described = (model.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("카탈로그에 없어");
    const instructions = screen.getByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "모델은 그대로.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { card: { model: string } }).card.model).toBe(
      "claude-legacy-4",
    );
  });

  test("카드 모델과 다른 모델의 profile을 고르면 release를 만들기 전에 알린다", async () => {
    const server = agentServer();
    renderAt(RELEASE_TAB, { ...meOk, ...server.routes });
    const user = await setupUser();
    const select = await screen.findByLabelText("프로필");
    await user.selectOptions(select, PROFILE);
    expect(screen.queryByText(/이대로 만들면 거부됩니다/)).toBeNull();
    await user.selectOptions(select, "claude-coding-fast");
    expect(
      (await screen.findByText(/이대로 만들면 거부됩니다/)).textContent,
    ).toBe(
      "카드 모델(이 version): claude-sonnet-5 · 고른 프로필의 모델: claude-haiku-5. 둘이 달라 이대로 만들면 거부됩니다.",
    );
  });

  test("저장 응답을 기다리는 동안 이어서 쓴 내용은 응답이 와도 남는다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        await gate;
        return patch ? patch(request) : json(500, {});
      },
    });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "첫 저장.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.type(screen.getByLabelText("지시 사항"), " 이어서 쓴 줄.");
    release();
    expect(await screen.findByText(/저장했습니다 — version 2/)).toBeDefined();
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe("첫 저장. 이어서 쓴 줄.");
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });

  test("다른 에이전트로 옮기면 이전 에이전트의 편집을 들고 가지 않는다", async () => {
    const server = agentServer();
    const OTHER = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
    const other = server.detail();
    const otherDetail = {
      ...other,
      agent: { ...other.agent, id: OTHER, slug: "refund", name: "환불 담당" },
      versions: other.versions.map((v) => ({
        ...v,
        agent_id: OTHER,
        card: { ...CARD, instructions: "환불 문의에 답한다." },
      })),
    };
    const { api, history } = renderAt(`/agents/${OTHER}?tab=card`, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${OTHER}`]: () => json(200, otherDetail),
      [`PATCH /v1/agents/${OTHER}`]: () => json(200, otherDetail),
    });
    // Visit the other agent first so it is cached when we come back to it.
    await screen.findByRole("heading", { name: "환불 담당" });
    history.push(CARD_TAB);
    await screen.findByRole("heading", { name: "결제 담당" });
    const user = await setupUser();
    const instructions = screen.getByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "결제 담당에게만 쓴 지시.");
    history.push(`/agents/${OTHER}?tab=card`);
    await screen.findByRole("heading", { name: "환불 담당" });
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe("환불 문의에 답한다.");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`/v1/agents/${OTHER}`);
    expect(JSON.stringify(patch?.body)).not.toContain("결제 담당에게만");
  });

  test("카드만 고쳤으면 다른 곳의 이름 변경을 되돌리지 않는다", async () => {
    const server = agentServer();
    let renamed = false;
    const get = () => {
      const detail = server.detail();
      return json(200, {
        ...detail,
        agent: { ...detail.agent, name: renamed ? "청구 담당" : "결제 담당" },
      });
    };
    const { api, services } = renderAt(CARD_TAB, {
      ...meOk,
      ...server.routes,
      [`GET /v1/agents/${AGENT_ID}`]: get,
    });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "카드만 고친다.");
    renamed = true;
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    await screen.findByRole("heading", { name: "청구 담당" });
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByText(/저장했습니다/);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).not.toHaveProperty("name");
  });

  test("고친 것이 없으면 최신 카드를 그대로 받아들인다", async () => {
    const server = agentServer();
    const { services } = renderAt(DETAIL, { ...meOk, ...server.routes });
    await screen.findByLabelText("지시 사항");
    otherTabSaves(server);
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.agent(AGENT_ID),
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
      ).toBe("다른 탭이 고친 지시."),
    );
    expect(screen.queryByText(/다른 곳에서 카드를 저장해/)).toBeNull();
  });
});

describe("식별자와 상태 문구", () => {
  test("slug는 이름을 따라 채워지다가 직접 고치면 멈춘다", async () => {
    renderAt("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const slug = (await screen.findByLabelText("식별자")) as HTMLInputElement;
    expect(
      document.getElementById(slug.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("다른 에이전트와 겹칠 수 없습니다");
    await user.type(screen.getByLabelText("이름"), "Billing Bot 2");
    expect(slug.value).toBe("billing-bot-2");
    await user.clear(slug);
    await user.type(slug, "pay");
    await user.type(screen.getByLabelText("이름"), "!");
    expect(slug.value).toBe("pay");
  });

  test("상세 머리는 상태 배지와 역할만 두고 식별자는 카드 탭에 둔다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const heading = await screen.findByRole("heading", { level: 1 });
    const head = heading.closest("[data-slot=page-header]") as HTMLElement;
    expect(within(head).getByText("아직 쓸 수 없음")).toBeDefined();
    expect(within(head).getByText("결제 문의 담당")).toBeDefined();
    expect(within(head).queryByText(/billing/)).toBeNull();
    const card = screen
      .getByRole("heading", { name: "에이전트 카드", hidden: true })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("billing")).toBeDefined();
    expect(screen.queryByText(/000000000001/)).toBeNull();
  });
});

describe("새 에이전트: 브라우저 history", () => {
  const LEAVE_TITLE = "저장하지 않고 나갈까요?";
  const back = async () => {
    act(() => window.history.back());
    // happy-dom delivers popstate on a timer.
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  test("초안 저장 뒤 뒤로 가면 하는 일 → 이름 → 목록이고, 새로고침 뒤에도 같은 길이다", async () => {
    const server = agentServer();
    const { api, reload } = openInBrowser("/agents", {
      ...meOk,
      ...server.routes,
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "새 에이전트" }),
    );
    await toJobStep(user);
    await fillJob(user);
    await atStep("배포 판");
    expect(stepsInState()).toEqual(["name", "job", "release"]);

    reload();
    await atStep("배포 판");
    expect(stepsInState()).toEqual(["name", "job", "release"]);
    await back();
    await atStep("하는 일");
    expect(stepsInState()).toEqual(["name", "job"]);
    await back();
    await atStep("이름");
    expect(stepsInState()).toEqual(["name"]);
    await back();
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    await screen.findByRole("link", { name: "결제 담당" });
    expect(screen.queryByText(LEAVE_TITLE)).toBeNull();
    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents"),
    ).toHaveLength(1);
  });

  test("하는 일 입력은 저장하지 않아도 새로고침 뒤에 남는다", async () => {
    const { reload } = openInBrowser("/agents/new", {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.type(screen.getByLabelText("지시 사항"), "짧게 답한다.");
    await waitFor(() =>
      expect(JSON.stringify(window.history.state)).toContain("짧게 답한다."),
    );

    reload();
    await atStep("하는 일");
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe("짧게 답한다.");
  });

  test("저장하지 않은 입력이 있으면 흐름을 떠나기 전에 묻고, 단계 사이 이동은 묻지 않는다", async () => {
    openInBrowser("/agents", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "새 에이전트" }),
    );
    await toJobStep(user);
    await user.type(screen.getByLabelText("역할"), CARD.role);
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(true);

    await back();
    await atStep("이름");
    expect(screen.queryByText(LEAVE_TITLE)).toBeNull();
    await back();
    const dialog = await screen.findByRole("dialog", { name: LEAVE_TITLE });
    await user.click(within(dialog).getByRole("button", { name: "계속 쓰기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.pathname).toBe("/agents/new");
    await atStep("이름");

    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    expect((screen.getByLabelText("역할") as HTMLInputElement).value).toBe(
      CARD.role,
    );
    await user.click(
      within(screen.getByRole("navigation", { name: "주요 메뉴" })).getByRole(
        "link",
        { name: "에이전트" },
      ),
    );
    await user.click(
      within(
        await screen.findByRole("dialog", { name: LEAVE_TITLE }),
      ).getByRole("button", { name: "나가기" }),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  });

  const unloadBlocked = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  test("저장한 뒤에는 묻지 않고 나간다: 앞뒤 공백을 다듬은 이름도 저장한 것으로 본다", async () => {
    openInBrowser("/agents/new", { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    await user.type(await screen.findByLabelText("이름"), "  결제 담당 ");
    await user.type(screen.getByLabelText("식별자"), "billing");
    await user.click(screen.getByRole("button", { name: "다음" }));
    await atStep("하는 일");
    await fillJob(user);
    await atStep("배포 판");
    expect(unloadBlocked()).toBe(false);
    await user.click(screen.getByRole("link", { name: "나중에 하기" }));
    await waitFor(() => expect(window.location.pathname).toBe(DETAIL));
    expect(screen.queryByText(LEAVE_TITLE)).toBeNull();
  });

  test("남겨 둔 입력을 고친 직후 저장해도 새로고침 뒤에는 저장한 입력이 남는다", async () => {
    const { api, reload } = openInBrowser("/agents/new", {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    await toJobStep(user);
    await user.type(screen.getByLabelText("역할"), CARD.role);
    await user.type(screen.getByLabelText("지시 사항"), "처음 쓴 것.");
    await user.selectOptions(await screen.findByLabelText("모델"), CARD.model);
    await waitFor(() =>
      expect(JSON.stringify(window.history.state)).toContain(CARD.model),
    );
    await user.type(screen.getByLabelText("지시 사항"), " 고친 것.");
    await user.click(
      screen.getByRole("button", { name: "초안 저장하고 다음" }),
    );
    await atStep("배포 판");
    const sent = (
      posted(api, "/v1/agents") as { card: { instructions: string } }
    ).card.instructions;
    expect(sent).toBe("처음 쓴 것. 고친 것.");

    reload();
    await atStep("배포 판");
    expect(unloadBlocked()).toBe(false);
    await back();
    await atStep("하는 일");
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe(sent);
  });
});

describe("에이전트 머리 경로", () => {
  const trail = async () => {
    const [header] = await screen.findAllByRole("banner");
    return within(header as HTMLElement);
  };

  test("상세는 에이전트 목록 링크 다음에 이름이 온다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const bar = await trail();
    expect(await bar.findByText("결제 담당")).toBeDefined();
    expect(
      bar.getByRole("link", { name: "에이전트" }).getAttribute("href"),
    ).toBe("/agents");
  });

  test("새 에이전트는 주소 끝에 /가 붙어도 화면 제목을 쓴다", async () => {
    renderAt("/agents/new/", { ...meOk, ...agentServer().routes });
    const bar = await trail();
    expect(await bar.findByText("새 에이전트")).toBeDefined();
  });
});
