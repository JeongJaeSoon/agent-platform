import { describe, expect, test } from "bun:test";
import {
  type Agent,
  type ApiKeyView,
  agentSchema,
  apiKeyViewSchema,
  createApiKeyResponseSchema,
  SESSION_SCOPE_VALUES,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiKeysEn, apiKeysKo } from "../i18n/api-keys.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const AGENT_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER_AGENT_ID = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
const KEY_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
// An agent the caller's agent list does not include.
const GONE_ID = "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c";
const RECEIPT_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
// Shaped only to pass the contract's length check; it reaches nothing.
const SECRET = `placeholder-value-${"0".repeat(32)}`;
const DAY = 24 * 60 * 60 * 1000;

const PERSONAL = "/settings/api-keys";
const NEW_PERSONAL = "/settings/api-keys/new";
const SERVICE = "/settings/api-keys/service";
const NEW_SERVICE = "/settings/api-keys/service/new";

function agent(id: string, name: string): Agent {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    slug: name.toLowerCase(),
    name,
    status: "active",
    active_release_id: null,
    activation_revision: -1,
    created_by: USER_ID,
    created_at: "2026-10-11T00:00:00.000Z",
    updated_at: "2026-10-11T00:00:00.000Z",
  };
}
const mine = agent(AGENT_ID, "Billing");
const theirs = agent(OTHER_AGENT_ID, "Support");

function key(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: KEY_ID,
    kind: "service",
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_ID,
    created_by: USER_ID,
    scopes: ["sessions:read"],
    created_at: "2026-10-11T00:00:00.000Z",
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function issued(view: ApiKeyView) {
  return { key: view, secret: SECRET, receipt_id: RECEIPT_ID };
}

/** A stateful keys API: issuing adds to the list, revoking marks the row. */
function keysServer(initial: ApiKeyView[] = []) {
  let items = [...initial];
  return {
    "GET /v1/api-keys": () => json(200, { items }),
    "POST /v1/api-keys": async (request: Request) => {
      const body = (await request.json()) as {
        kind: ApiKeyView["kind"];
        scopes: ApiKeyView["scopes"];
        agent_id?: string;
        expires_at?: string;
      };
      const view = key({
        id: crypto.randomUUID(),
        kind: body.kind,
        agent_id: body.agent_id ?? null,
        scopes: body.scopes,
        expires_at: body.expires_at ?? null,
      });
      items = [view, ...items];
      return json(201, issued(view));
    },
    [`DELETE /v1/api-keys/${KEY_ID}`]: () => {
      items = items.map((item) =>
        item.id === KEY_ID
          ? { ...item, revoked_at: "2026-10-11T01:00:00.000Z" }
          : item,
      );
      return json(200, {
        key: items.find((item) => item.id === KEY_ID),
        receipt_id: RECEIPT_ID,
      });
    },
  };
}

const memberOk = {
  "GET /v1/auth/me": () => json(200, memberMe()),
  "GET /v1/administered-agents": () => json(200, { items: [mine] }),
};
const ownerOk = {
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/agents": () => json(200, { items: [mine, theirs] }),
};

const rows = () =>
  screen.getAllByRole("listitem").filter((li) => li.dataset.revoked);
const badgeOf = (row: HTMLElement) =>
  row.querySelector("[data-slot=badge]") as HTMLElement;

describe("API key", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(agentSchema.safeParse(mine).success).toBe(true);
    expect(apiKeyViewSchema.safeParse(key()).success).toBe(true);
    expect(createApiKeyResponseSchema.safeParse(issued(key())).success).toBe(
      true,
    );
  });

  test("내 key 화면은 개인 key만 보이고, 목록 아래 안내 상자에서 개인 key를 설명한다", async () => {
    renderAt(PERSONAL, {
      ...ownerOk,
      ...keysServer([
        key(),
        key({
          id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
          kind: "personal",
          agent_id: null,
        }),
      ]),
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "내 key" }),
    ).toBeDefined();
    await screen.findByText("4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a");
    expect(rows().map((row) => badgeOf(row).textContent)).toEqual(["개인 key"]);
    const guide = screen.getByTestId("guide-personal");
    expect(
      within(guide)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      apiKeysKo["apiKeys.guide.personal.actsAs"],
      apiKeysKo["apiKeys.guide.personal.issuerLeaves"],
      apiKeysKo["apiKeys.guide.personal.sessions"],
      apiKeysKo["apiKeys.guide.personal.approve"],
    ]);
    expect(screen.queryByTestId("guide-service")).toBeNull();
    // The list comes before the guide.
    const list = screen.getByRole("list", { name: "발급된 key" });
    expect(
      list.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("서비스 key 화면은 서비스·에이전트 전용 key를 서로 다른 배지로, 에이전트 전용 key는 에이전트 이름으로 보인다", async () => {
    renderAt(SERVICE, {
      ...ownerOk,
      ...keysServer([
        key(),
        key({
          id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
          agent_id: null,
        }),
        key({
          id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a",
          kind: "personal",
          agent_id: null,
        }),
        key({ id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", agent_id: GONE_ID }),
      ]),
    });
    await screen.findByText("Billing · 세션 보기");
    const listed = rows();
    expect(listed.map((row) => badgeOf(row).textContent)).toEqual([
      "에이전트 전용 key",
      "서비스 key",
      "에이전트 전용 key",
    ]);
    expect(
      new Set(listed.slice(0, 2).map((row) => badgeOf(row).className)).size,
    ).toBe(2);
    // An agent this person cannot list still shows by its id.
    expect(
      within(listed[2] as HTMLElement).getByText(`${GONE_ID} · 세션 보기`),
    ).toBeDefined();
    expect(
      within(listed[1] as HTMLElement).getByText("발급자가 떠나도 유효"),
    ).toBeDefined();
    for (const kind of ["service", "agent"] as const) {
      expect(screen.getByTestId(`guide-${kind}`)).toBeDefined();
    }
    expect(screen.queryByTestId("guide-personal")).toBeNull();
  });

  test("두 화면은 같은 머리글 구조이고 하위 내비로 오간다", async () => {
    renderAt(PERSONAL, {
      ...ownerOk,
      ...keysServer([key({ kind: "personal", agent_id: null })]),
    });
    const nav = await screen.findByRole("navigation", { name: "key 목록" });
    // Counts wait for the list; the parent path is not current on its child.
    const mine = await within(nav).findByRole("link", { name: "내 key 1개" });
    const service = within(nav).getByRole("link", { name: "서비스 key 0개" });
    expect(mine.getAttribute("aria-current")).toBe("page");
    expect(service.getAttribute("aria-current")).toBeNull();
    const user = await setupUser();
    await user.click(service);
    expect(
      await screen.findByRole("heading", { level: 1, name: "서비스 key" }),
    ).toBeDefined();
    // The service screen draws its own tabs.
    const after = screen.getByRole("navigation", { name: "key 목록" });
    expect(
      within(after)
        .getByRole("link", { name: /^내 key/ })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(
      within(after)
        .getByRole("link", { name: /^서비스 key/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("button", { name: "새 key" })).toBeDefined();
    expect(screen.getByText("아직 서비스 key가 없습니다.")).toBeDefined();
  });

  test("key ID는 잘리지 않고 전체로 보이며 복사할 수 있다", async () => {
    renderAt(SERVICE, { ...ownerOk, ...keysServer([key()]) });
    expect(await screen.findByText(KEY_ID)).toBeDefined();
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    try {
      const button = screen.getByRole("button", { name: `ID ${KEY_ID} 복사` });
      await act(async () => button.click());
      expect(written).toEqual([KEY_ID]);
      expect(button.textContent).toBe("복사했습니다");
      expect(
        within(rows()[0] as HTMLElement).getByRole("status").textContent,
      ).toBe("복사했습니다");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("만료 임박과 만료됨은 상태 색으로, 만료 없는 key는 그렇다고 보인다", async () => {
    const soon = new Date(Date.now() + 2 * DAY).toISOString();
    const past = new Date(Date.now() - DAY).toISOString();
    const later = new Date(Date.now() + 60 * DAY).toISOString();
    renderAt(PERSONAL, {
      ...ownerOk,
      ...keysServer(
        [soon, past, later, null].map((expires_at, index) =>
          key({
            id: `${index}a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`,
            kind: "personal",
            agent_id: null,
            expires_at,
          }),
        ),
      ),
    });
    await screen.findByText("만료 없음");
    const states = rows().map((row) => {
      const marked = row.querySelector("[data-expiry]") as HTMLElement | null;
      return marked
        ? `${marked.dataset.expiry}/${marked.dataset.tone}`
        : "plain";
    });
    expect(states).toEqual([
      "soon/caution",
      "expired/danger",
      "plain",
      "none/caution",
    ]);
    expect(rows()[0]?.textContent).toContain("곧 만료 · ");
    expect(rows()[1]?.textContent).toContain("만료됨 · ");
  });

  test("새 key 버튼은 만들기 화면으로 가고, 취소하면 목록으로 돌아온다", async () => {
    const { history } = renderAt(PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "새 key" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "새 개인 key" }),
    ).toBeDefined();
    expect(history.location.pathname).toBe(NEW_PERSONAL);
    await user.click(screen.getByRole("link", { name: "취소" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "내 key" }),
    ).toBeDefined();
  });

  test("에이전트 관리자인 구성원은 워크스페이스 전체를 고를 수 없다", async () => {
    renderAt(NEW_SERVICE, { ...memberOk, ...keysServer() });
    await screen.findByRole("option", { name: "Billing" });
    expect(
      screen.queryByRole("option", {
        name: "워크스페이스 전체 (에이전트 지정 없음)",
      }),
    ).toBeNull();
    expect(screen.queryByRole("option", { name: "Support" })).toBeNull();
    expect(document.body.textContent).not.toContain("api_key.manage");
  });

  test("에이전트 관리자인 구성원은 자기 에이전트 전용 key를 받고, 값은 그 화면에서 한 번만 보인다", async () => {
    const { api, history, services } = renderAt(NEW_SERVICE, {
      ...memberOk,
      ...keysServer(),
    });
    const cached = () =>
      services.queryClient
        .getMutationCache()
        .getAll()
        .some((m) => JSON.stringify(m.state.data ?? null).includes(SECRET));
    const user = await setupUser();
    await screen.findByRole("option", { name: "Billing" });
    await user.click(
      screen.getByRole("checkbox", { name: /sessions:approve/ }),
    );
    await user.selectOptions(screen.getByLabelText("대상"), AGENT_ID);
    await user.click(screen.getByRole("button", { name: "key 만들기" }));

    const secret = await screen.findByRole("region", { name: "새 key" });
    expect(
      (within(secret).getByLabelText("key 값") as HTMLInputElement).value,
    ).toBe(SECRET);
    expect(
      within(secret).getByText(apiKeysKo["apiKeys.secretOnce"]),
    ).toBeDefined();
    expect(
      api.calls.filter((c) => c.method === "POST").map((c) => c.body),
    ).toEqual([
      { kind: "service", scopes: ["sessions:read"], agent_id: AGENT_ID },
    ]);
    expect(api.calls.some((c) => c.path === "/v1/agents")).toBe(false);
    // Nothing else is issued from here while the secret shows.
    expect(screen.queryByRole("button", { name: "key 만들기" })).toBeNull();
    // The whole id, not a prefix.
    expect(
      within(secret).getByText(
        /ID [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    ).toBeDefined();
    expect(history.location.href).not.toContain(SECRET);
    expect(JSON.stringify(history.location.state ?? null)).not.toContain(
      SECRET,
    );

    await user.click(screen.getByRole("link", { name: "목록으로" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "서비스 key" }),
    ).toBeDefined();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    await waitFor(() => expect(cached()).toBe(false));

    // Coming back to the page shows a fresh form, not the secret.
    await act(async () => history.back());
    expect(
      await screen.findByRole("button", { name: "key 만들기" }),
    ).toBeDefined();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
  });

  test("권한은 이름과 설명으로 고르고, 목록도 이름으로 보인다", async () => {
    renderAt(SERVICE, {
      ...memberOk,
      ...keysServer([key({ scopes: ["sessions:read", "sessions:write"] })]),
    });
    expect(
      await screen.findByText("Billing · 세션 보기, 세션 만들기"),
    ).toBeDefined();
    // Read from the scopes: without sessions:approve it cannot approve.
    expect(screen.getByText("승인 불가").dataset.approve).toBe("false");
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "새 key" }));
    const read = await screen.findByRole("checkbox", {
      name: "세션 보기 sessions:read",
    });
    expect(describedBy(read)[0]).toContain("영수증·사용량·공유 설정");
  });

  test("승인 범위만 고르면 에이전트 전용 key 버튼이 이유와 함께 닫혀 있다", async () => {
    renderAt(NEW_SERVICE, { ...memberOk, ...keysServer() });
    const user = await setupUser();
    await screen.findByRole("option", { name: "Billing" });
    await user.click(screen.getByRole("checkbox", { name: /sessions:read/ }));
    await user.click(
      screen.getByRole("checkbox", { name: /sessions:approve/ }),
    );
    await user.selectOptions(screen.getByLabelText("대상"), AGENT_ID);
    const button = screen.getByRole("button", { name: "key 만들기" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      "권한을 하나 이상 고르세요. 에이전트 전용 key에는 sessions:approve를 넣을 수 없습니다.",
    );
  });

  test("관리 에이전트 조회가 실패하면 없다고 하지 않고 실패를 이유로 보인다", async () => {
    renderAt(NEW_SERVICE, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Backend unavailable"),
      ...keysServer(),
    });
    const button = await screen.findByRole("button", { name: "key 만들기" });
    await waitFor(() =>
      expect(
        document.getElementById(button.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBe("서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요."),
    );
    expect(screen.queryByText("관리하는 에이전트가 없습니다.")).toBeNull();
  });

  test("관리하는 에이전트가 없는 구성원에게는 서비스 key로 가는 길이 없다", async () => {
    const { services } = renderAt(PERSONAL, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...keysServer(),
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "내 key" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        services.queryClient.getQueryState(["administered-agents"])?.status,
      ).toBe("success"),
    );
    expect(screen.queryByRole("navigation", { name: "key 목록" })).toBeNull();
    expect(screen.queryByRole("link", { name: "서비스 key" })).toBeNull();
    expect(document.body.textContent).not.toContain("api_key.manage");
  });

  test("개인 key는 고른 범위와 만료일로 만들고, 값 칸으로 포커스가 간다", async () => {
    const { api } = renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("checkbox", { name: /sessions:write/ }),
    );
    await user.type(screen.getByLabelText(/^만료일/), "2026-12-31");
    await user.click(screen.getByRole("button", { name: "key 만들기" }));
    const secret = await screen.findByRole("region", { name: "새 key" });
    const field = within(secret).getByLabelText("key 값");
    await waitFor(() => expect(document.activeElement === field).toBe(true));
    const [body] = api.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.body as Record<string, unknown>);
    expect(body?.kind).toBe("personal");
    expect(body?.scopes).toEqual(["sessions:read", "sessions:write"]);
    expect(
      new Date(String(body?.expires_at)).getTime() >
        new Date("2026-12-31T00:00:00").getTime(),
    ).toBe(true);
    expect(badgeOf(secret).textContent).toBe("개인 key");
  });

  test("만료일은 오늘부터 고를 수 있다", async () => {
    renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    expect((await screen.findByLabelText(/^만료일/)).getAttribute("min")).toBe(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    );
  });

  test("서비스 key도 지난 날짜를 만료일로 보내지 않는다", async () => {
    const { api } = renderAt(NEW_SERVICE, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.type(await screen.findByLabelText(/^만료일/), "2020-01-01");
    await user.click(screen.getByRole("button", { name: "key 만들기" }));
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.queryByRole("region", { name: "새 key" })).toBeNull();
  });

  test("값 복사에 실패하면 그렇다고 알리고 값 칸에 포커스를 둔다", async () => {
    renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "key 만들기" }));
    const secret = await screen.findByRole("region", { name: "새 key" });
    const field = within(secret).getByLabelText("key 값");

    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    try {
      const copyButton = within(secret).getByRole("button", { name: "복사" });
      // The refusal settles after the click returns; act flushes it.
      await act(async () => copyButton.click());
      expect((await within(secret).findByRole("alert")).textContent).toBe(
        "복사하지 못했습니다. 위 칸의 값을 직접 선택해 복사하세요.",
      );
      expect(document.activeElement === field).toBe(true);
      expect(within(secret).queryByText("복사했습니다")).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("값 복사에 성공하면 status 영역이 그렇다고 알린다", async () => {
    renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "key 만들기" }));
    const secret = await screen.findByRole("region", { name: "새 key" });

    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    try {
      const status = within(secret).getByRole("status");
      expect(status.textContent).toBe("");
      await act(async () =>
        within(secret).getByRole("button", { name: "복사" }).click(),
      );
      expect(status.textContent).toBe("복사했습니다");
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("공백 없는 긴 에이전트 이름도 행 폭 안에서 줄을 바꾼다", async () => {
    const long = { ...mine, name: `billing_${"x".repeat(80)}` };
    renderAt(SERVICE, {
      ...ownerOk,
      "GET /v1/agents": () => json(200, { items: [long] }),
      ...keysServer([key()]),
    });
    const title = await screen.findByText(`${long.name} · 세션 보기`);
    // Layout is not measured here; the live 390px check covers the width.
    expect(title.classList.contains("min-w-0")).toBe(true);
    expect(title.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
  });

  test("폐기는 확인 뒤에 하고 행이 폐기됨으로 바뀐다", async () => {
    renderAt(SERVICE, { ...ownerOk, ...keysServer([key()]) });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: `에이전트 전용 key · Billing (${KEY_ID}) 폐기`,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(`ID ${KEY_ID} key를 폐기할까요?`),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "폐기" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").map((status) => status.textContent),
      ).toContain("key를 폐기했습니다."),
    );
    await waitFor(() => expect(screen.getByText(/^폐기됨/)).toBeDefined());
    expect(screen.queryByRole("button", { name: /폐기$/ })).toBeNull();
  });

  test("가진 것보다 넓은 범위(403)는 우리 문구만 보이고 서버의 영어 문구는 없다", async () => {
    renderAt(NEW_PERSONAL, {
      ...ownerOk,
      ...keysServer(),
      "POST /v1/api-keys": () =>
        apiError(
          403,
          "SCOPE_NOT_GRANTABLE",
          "An agent key cannot carry sessions:approve",
        ),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "key 만들기" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "내가 가진 것보다 많은 권한을 key에 줄 수 없습니다.",
    );
  });

  test("역할이 바뀌어 서버가 403이면 같은 이유 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt(NEW_SERVICE, {
      ...ownerOk,
      ...keysServer(),
      "POST /v1/api-keys": () =>
        apiError(
          403,
          "FORBIDDEN",
          "This principal does not hold api_key.manage",
        ),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "key 만들기" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "서비스 key 발급 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });

  for (const [locale, catalog, button] of [
    ["ko", apiKeysKo, "key 만들기"],
    ["en", apiKeysEn, "Generate key"],
  ] as const) {
    test(`권한마다 무엇을 허락하는지 한 줄 설명이 붙는다 (${locale})`, async () => {
      renderAt(NEW_PERSONAL, { ...ownerOk, ...keysServer() }, locale);
      await screen.findByRole("button", { name: button });
      for (const scope of SESSION_SCOPE_VALUES) {
        const box = screen.getByRole("checkbox", {
          name: new RegExp(`${scope}$`),
        });
        const hint = `apiKeys.scopeHint.${scope.slice("sessions:".length)}`;
        expect(describedBy(box)).toEqual([
          catalog[hint as keyof typeof catalog],
        ]);
      }
    });
  }

  test("에이전트 전용 key에 넣을 수 없는 권한은 설명 뒤에 그 이유도 읽힌다", async () => {
    renderAt(NEW_SERVICE, { ...ownerOk, ...keysServer() });
    expect(
      describedBy(
        await screen.findByRole("checkbox", {
          name: "요청에 답하기 sessions:approve",
        }),
      ),
    ).toEqual([
      "세션이 기다리는 권한 요청과 질문에 답합니다.",
      "에이전트 전용 key에는 넣을 수 없습니다. 에이전트가 사람 대신 승인할 수는 없습니다.",
    ]);
  });

  test("발급된 값은 query 캐시와 console에 남지 않는다", async () => {
    const logged: unknown[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) {
      console[name] = (...args: unknown[]) => {
        logged.push(...args);
      };
    }
    try {
      const { services } = renderAt(NEW_PERSONAL, {
        ...ownerOk,
        ...keysServer(),
      });
      const user = await setupUser();
      await user.click(
        await screen.findByRole("button", { name: "key 만들기" }),
      );
      await screen.findByRole("region", { name: "새 key" });
      const queries = services.queryClient.getQueryCache().getAll();
      expect(
        queries.some((q) =>
          JSON.stringify(q.state.data ?? null).includes(SECRET),
        ),
      ).toBe(false);
      expect(logged.some((arg) => String(arg).includes(SECRET))).toBe(false);
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index] as (typeof console)[typeof name];
      });
    }
  });
});

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `missing:${id}`);
}
