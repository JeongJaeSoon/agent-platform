import { describe, expect, test } from "bun:test";
import {
  type Agent,
  type ApiKeyView,
  agentSchema,
  apiKeyViewSchema,
  createApiKeyResponseSchema,
} from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
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
const RECEIPT_ID = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
// A placeholder shaped like a secret; it reaches nothing.
const SECRET = `ap_test_${"x".repeat(40)}`;

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

describe("API key", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(agentSchema.safeParse(mine).success).toBe(true);
    expect(apiKeyViewSchema.safeParse(key()).success).toBe(true);
    expect(createApiKeyResponseSchema.safeParse(issued(key())).success).toBe(
      true,
    );
  });

  test("서비스 key 영역은 발급자가 떠나도 유효하다고 말한다", async () => {
    renderAt("/settings/api-keys", { ...ownerOk, ...keysServer([key()]) });
    expect(
      (await screen.findByTestId("survives-issuer")).textContent,
    ).toContain("발급자가 떠나도 유효");
    const row = (
      await screen.findByText("에이전트 전용 key · Billing")
    ).closest("li") as HTMLElement;
    expect(within(row).getByText("발급자가 떠나도 유효")).toBeDefined();
  });

  test("에이전트 관리자인 구성원에게는 워크스페이스 서비스 key 버튼이 없다", async () => {
    renderAt("/settings/api-keys", { ...memberOk, ...keysServer() });
    expect(
      await screen.findByRole("button", { name: "에이전트 전용 key 발급" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "워크스페이스 서비스 key 발급" }),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("api_key.manage");
  });

  test("에이전트 관리자인 구성원은 자기 에이전트 전용 key를 받고, 값은 한 번만 보인다", async () => {
    const { api, services } = renderAt("/settings/api-keys", {
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
    expect(screen.queryByRole("option", { name: "Support" })).toBeNull();
    const service = screen.getByRole("region", { name: "서비스 key" });
    await user.click(
      within(service).getByRole("checkbox", { name: /sessions:approve/ }),
    );
    await user.selectOptions(within(service).getByRole("combobox"), AGENT_ID);
    await user.click(
      screen.getByRole("button", { name: "에이전트 전용 key 발급" }),
    );

    const secret = await screen.findByRole("region", { name: "새 key" });
    expect(
      (within(secret).getByLabelText("key 값") as HTMLInputElement).value,
    ).toBe(SECRET);
    expect(
      api.calls.filter((c) => c.method === "POST").map((c) => c.body),
    ).toEqual([
      { kind: "service", scopes: ["sessions:read"], agent_id: AGENT_ID },
    ]);
    expect(api.calls.some((c) => c.path === "/v1/agents")).toBe(false);

    // Nothing else is issued while this secret is still on screen.
    for (const name of ["개인 key 발급", "에이전트 전용 key 발급"]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
    expect(within(secret).getByText(/ID [0-9a-f]{8}/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "복사했으니 닫기" }));
    expect(
      screen
        .getByRole("button", { name: "개인 key 발급" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByRole("region", { name: "새 key" })).toBeNull();
    expect(screen.queryByDisplayValue(SECRET)).toBeNull();
    await waitFor(() => expect(cached()).toBe(false));
  });

  test("권한은 이름과 설명으로 고르고, 목록도 이름으로 보인다", async () => {
    renderAt("/settings/api-keys", {
      ...memberOk,
      ...keysServer([key({ scopes: ["sessions:read", "sessions:write"] })]),
    });
    const [read] = await screen.findAllByRole("checkbox", {
      name: /세션 보기 sessions:read/,
    });
    expect(read?.closest("label")?.textContent).toContain(
      "세션 목록과 상태, 이벤트를 읽습니다.",
    );
    expect(
      await screen.findByText(/ID [0-9a-f]{8} · 세션 보기, 세션 만들기 · /),
    ).toBeDefined();
  });

  test("승인 범위만 고르면 에이전트 전용 key 버튼이 이유와 함께 닫혀 있다", async () => {
    renderAt("/settings/api-keys", { ...memberOk, ...keysServer() });
    const user = await setupUser();
    await screen.findByRole("option", { name: "Billing" });
    const service = screen.getByRole("region", { name: "서비스 key" });
    await user.click(
      within(service).getByRole("checkbox", { name: /sessions:read/ }),
    );
    await user.click(
      within(service).getByRole("checkbox", { name: /sessions:approve/ }),
    );
    await user.selectOptions(within(service).getByRole("combobox"), AGENT_ID);
    const button = screen.getByRole("button", {
      name: "에이전트 전용 key 발급",
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      "권한을 하나 이상 고르세요. 에이전트 전용 key에는 sessions:approve를 넣을 수 없습니다.",
    );
  });

  test("관리 에이전트 조회가 실패하면 없다고 하지 않고 실패를 이유로 보인다", async () => {
    renderAt("/settings/api-keys", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Backend unavailable"),
      ...keysServer(),
    });
    const button = await screen.findByRole("button", {
      name: "에이전트 전용 key 발급",
    });
    await waitFor(() =>
      expect(
        document.getElementById(button.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBe("서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요."),
    );
    expect(screen.queryByText("관리하는 에이전트가 없습니다.")).toBeNull();
  });

  test("관리하는 에이전트가 없는 구성원에게는 서비스 key 칸이 없다", async () => {
    const { services } = renderAt("/settings/api-keys", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...keysServer(),
    });
    expect(
      await screen.findByRole("region", { name: "개인 key" }),
    ).toBeDefined();
    // The section stays hidden while the list loads, so wait for the answer.
    await waitFor(() =>
      expect(
        services.queryClient.getQueryState(["administered-agents"])?.status,
      ).toBe("success"),
    );
    expect(screen.queryByRole("region", { name: "서비스 key" })).toBeNull();
    expect(document.body.textContent).not.toContain("api_key.manage");
  });

  test("개인 key는 고른 범위와 만료일로 발급한다", async () => {
    const { api } = renderAt("/settings/api-keys", {
      ...ownerOk,
      ...keysServer(),
    });
    const user = await setupUser();
    const personal = await screen.findByRole("region", { name: "개인 key" });
    await user.click(
      within(personal).getByRole("checkbox", { name: /sessions:write/ }),
    );
    await user.type(within(personal).getByLabelText(/^만료일/), "2026-12-31");
    await user.click(
      within(personal).getByRole("button", { name: "개인 key 발급" }),
    );
    await screen.findByRole("region", { name: "새 key" });
    const [body] = api.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.body as Record<string, unknown>);
    expect(body?.kind).toBe("personal");
    expect(body?.scopes).toEqual(["sessions:read", "sessions:write"]);
    expect(
      new Date(String(body?.expires_at)).getTime() >
        new Date("2026-12-31T00:00:00").getTime(),
    ).toBe(true);
    expect((await screen.findAllByText("개인 key")).length).toBe(2);
  });

  test("만료일은 오늘부터 고를 수 있다", async () => {
    renderAt("/settings/api-keys", { ...ownerOk, ...keysServer() });
    const personal = await screen.findByRole("region", { name: "개인 key" });
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(
      within(personal)
        .getByLabelText(/^만료일/)
        .getAttribute("min"),
    ).toBe(
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    );
  });

  test("서비스 key도 지난 날짜를 만료일로 보내지 않는다", async () => {
    const { api } = renderAt("/settings/api-keys", {
      ...ownerOk,
      ...keysServer(),
    });
    const user = await setupUser();
    const service = await screen.findByRole("region", { name: "서비스 key" });
    await user.type(within(service).getByLabelText(/^만료일/), "2020-01-01");
    await user.click(
      within(service).getByRole("button", {
        name: "워크스페이스 서비스 key 발급",
      }),
    );
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.queryByRole("region", { name: "새 key" })).toBeNull();
  });

  test("새 key 값으로 포커스가 가고, 복사에 실패하면 그렇다고 알린다", async () => {
    renderAt("/settings/api-keys", { ...ownerOk, ...keysServer() });
    const user = await setupUser();
    const personal = await screen.findByRole("region", { name: "개인 key" });
    await user.click(
      within(personal).getByRole("button", { name: "개인 key 발급" }),
    );
    const secret = await screen.findByRole("region", { name: "새 key" });
    const field = within(secret).getByLabelText("key 값");
    await waitFor(() => expect(document.activeElement).toBe(field));

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
      // The refusal settles after user-event's click returns; act flushes it.
      await act(async () => copyButton.click());
      expect((await within(secret).findByRole("alert")).textContent).toBe(
        "복사하지 못했습니다. 위 칸의 값을 직접 선택해 복사하세요.",
      );
      expect(document.activeElement).toBe(field);
      expect(within(secret).queryByText("복사했습니다")).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("폐기는 확인 뒤에 하고 행이 폐기됨으로 바뀐다", async () => {
    renderAt("/settings/api-keys", { ...ownerOk, ...keysServer([key()]) });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "에이전트 전용 key · Billing (1a2b3c4d) 폐기",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("ID 1a2b3c4d key를 폐기할까요?"),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "폐기" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "key를 폐기했습니다.",
    );
    await waitFor(() => expect(screen.getByText(/^폐기됨/)).toBeDefined());
  });

  test("가진 것보다 넓은 범위(403)는 우리 문구만 보이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/api-keys", {
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
    const personal = await screen.findByRole("region", { name: "개인 key" });
    await user.click(
      within(personal).getByRole("button", { name: "개인 key 발급" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "내가 가진 것보다 많은 권한을 key에 줄 수 없습니다.",
    );
  });

  test("역할이 바뀌어 서버가 403이면 같은 이유 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/api-keys", {
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
    await user.click(
      await screen.findByRole("button", {
        name: "워크스페이스 서비스 key 발급",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "서비스 key 발급 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });
});
