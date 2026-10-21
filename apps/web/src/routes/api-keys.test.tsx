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

  test("세 종류마다 누구로 동작하는지, 발급자가 떠나면 어떻게 되는지, 닿는 세션, 승인 가능 여부를 한 줄씩 말한다", async () => {
    renderAt("/settings/api-keys", { ...ownerOk, ...keysServer() });
    for (const kind of ["personal", "service", "agent"] as const) {
      const guide = await screen.findByTestId(`guide-${kind}`);
      expect(
        within(guide)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        apiKeysKo[`apiKeys.guide.${kind}.actsAs`],
        apiKeysKo[`apiKeys.guide.${kind}.issuerLeaves`],
        apiKeysKo[`apiKeys.guide.${kind}.sessions`],
        apiKeysKo[`apiKeys.guide.${kind}.approve`],
      ]);
    }
  });

  test("목록은 세 종류를 서로 다른 배지로, 에이전트 전용 key는 에이전트 이름으로 보인다", async () => {
    renderAt("/settings/api-keys", {
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
    await screen.findByText("Billing");
    const rows = screen
      .getAllByRole("listitem")
      .filter((li) => li.dataset.revoked);
    const badgeOf = (row: HTMLElement) =>
      row.querySelector("[data-slot=badge]") as HTMLElement;
    expect(rows.map((row) => badgeOf(row).textContent)).toEqual([
      "에이전트 전용 key",
      "서비스 key",
      "개인 key",
      "에이전트 전용 key",
    ]);
    const variants = new Set(
      rows.slice(0, 3).map((row) => badgeOf(row).className),
    );
    expect(variants.size).toBe(3);
    expect(within(rows[0] as HTMLElement).getByText("Billing")).toBeDefined();
    // An agent this person cannot list still shows by its id.
    expect(within(rows[3] as HTMLElement).getAllByText(GONE_ID).length).toBe(1);
    expect(
      within(rows[1] as HTMLElement).getByText("발급자가 떠나도 유효"),
    ).toBeDefined();
  });

  test("key ID는 잘리지 않고 전체로 보이며 복사할 수 있다", async () => {
    renderAt("/settings/api-keys", { ...ownerOk, ...keysServer([key()]) });
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
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("에이전트 관리자인 구성원에게는 서비스 key 발급 버튼이 없다", async () => {
    renderAt("/settings/api-keys", { ...memberOk, ...keysServer() });
    expect(
      await screen.findByRole("button", { name: "에이전트 전용 key 발급" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "서비스 key 발급" }),
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
    // The whole id, not a prefix.
    expect(
      within(secret).getByText(
        /ID [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    ).toBeDefined();
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
      name: "세션 보기 sessions:read",
    });
    expect(describedBy(read as HTMLElement)[0]).toContain(
      "영수증·사용량·공유 설정",
    );
    expect(await screen.findByText(/^세션 보기, 세션 만들기 · /)).toBeDefined();
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
    // The section title, the guide's badge and the new row's badge.
    expect((await screen.findAllByText("개인 key")).length).toBe(3);
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
      within(service).getByRole("button", { name: "서비스 key 발급" }),
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
        name: `에이전트 전용 key · Billing (${KEY_ID}) 폐기`,
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(`ID ${KEY_ID} key를 폐기할까요?`),
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
      await screen.findByRole("button", { name: "서비스 key 발급" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "서비스 key 발급 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });

  for (const [locale, catalog, region] of [
    ["ko", apiKeysKo, "개인 key"],
    ["en", apiKeysEn, "Personal key"],
  ] as const) {
    test(`권한마다 무엇을 허락하는지 한 줄 설명이 붙는다 (${locale})`, async () => {
      renderAt("/settings/api-keys", { ...ownerOk, ...keysServer() }, locale);
      const personal = await screen.findByRole("region", { name: region });
      for (const scope of SESSION_SCOPE_VALUES) {
        const box = within(personal).getByRole("checkbox", {
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
    renderAt("/settings/api-keys", { ...ownerOk, ...keysServer() });
    const service = await screen.findByRole("region", { name: "서비스 key" });
    expect(
      describedBy(
        within(service).getByRole("checkbox", {
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
      const { services } = renderAt("/settings/api-keys", {
        ...ownerOk,
        ...keysServer(),
      });
      const user = await setupUser();
      const personal = await screen.findByRole("region", { name: "개인 key" });
      await user.click(
        within(personal).getByRole("button", { name: "개인 key 발급" }),
      );
      await screen.findByRole("region", { name: "새 key" });
      // The list refetch after issuing must carry the key, not its secret.
      await waitFor(() =>
        expect(screen.getAllByText("개인 key").length).toBe(3),
      );
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
