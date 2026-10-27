import { describe, expect, test } from "bun:test";
import type {
  CreateWorkspaceProfileRequest,
  ProfileSummary,
  WorkspaceProfileState,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const RECEIPT_ID = "00000000-0000-4000-8000-000000000001";

const PROFILES: ProfileSummary[] = [
  {
    id: "coding-claude",
    source: "operator",
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-haiku-5"],
    tools: ["Read", "Edit", "Bash"],
    permission_mode: "acceptEdits",
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "metered",
    repository_mode: "required",
  },
  {
    id: "general-read",
    source: "operator",
    model: "claude-haiku-5",
    models: ["claude-haiku-5"],
    tools: [],
    permission_mode: "default",
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "none",
    repository_mode: "none",
  },
];

function version(
  n: number,
  state: WorkspaceProfileState,
  narrowed: Partial<ProfileSummary> = {},
): ProfileSummary {
  return {
    ...(PROFILES[0] as ProfileSummary),
    id: `ws_acme_strict_v${n}`,
    source: "workspace",
    models: ["claude-sonnet-5"],
    tools: ["Read"],
    permission_mode: "default",
    ...narrowed,
    workspace: {
      name: "strict",
      version: n,
      base_profile_id: "coding-claude",
      state,
      created_at: "2026-10-27T00:00:00.000Z",
      retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
    },
  };
}

const rows = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .map((row) =>
      Array.from(
        row.querySelectorAll('[role="cell"], [role="columnheader"]'),
        (cell) => cell.textContent,
      ),
    );

function catalog(start: ProfileSummary[] = PROFILES) {
  const items = [...start];
  return {
    items,
    routes: {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => json(200, { items }),
      "POST /v1/workspace-profiles": async (request: Request) => {
        const { name, base_profile_id, ...narrowed } =
          (await request.json()) as CreateWorkspaceProfileRequest;
        const body = { name, base_profile_id };
        const n =
          Math.max(
            0,
            ...items
              .filter((item) => item.workspace?.name === body.name)
              .map((item) => item.workspace?.version ?? 0),
          ) + 1;
        const made: ProfileSummary = {
          ...version(n, "usable"),
          ...narrowed,
          id: `ws_acme_${body.name}_v${n}`,
          workspace: {
            ...(version(n, "usable").workspace as NonNullable<
              ProfileSummary["workspace"]
            >),
            name: body.name,
            base_profile_id: body.base_profile_id,
          },
        };
        items.push(made);
        return json(201, { profile: made, receipt_id: RECEIPT_ID });
      },
    },
  };
}

describe("실행 프로필", () => {
  test("lists the operator's profiles from the sidebar and says this workspace has none yet", async () => {
    const { api } = renderAt("/", catalog().routes);
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    const user = await setupUser();
    await user.click(
      await within(nav).findByRole("link", { name: "실행 프로필" }),
    );
    await screen.findByRole("heading", { level: 1, name: "실행 프로필" });
    expect(
      within(nav)
        .getByRole("link", { name: "실행 프로필" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const table = await screen.findByRole("table", { name: "운영자 프로필" });
    // Every value stays in its row at any width; nothing hides narrow.
    expect(rows(table)).toEqual([
      ["프로필", "모델", "실행 환경"],
      [
        "coding-claudeClaude Agent SDK 0.3.270",
        "claude-sonnet-5비용 집계",
        "저장소 필요Read, Edit, Bash",
      ],
      [
        "general-readClaude Agent SDK 0.3.270",
        "claude-haiku-5비용 집계 안 함",
        "저장소 쓰지 않음도구 없음",
      ],
    ]);
    // DOM tests cannot see CSS clipping: no cell hides narrow or truncates
    // (GridTableCell `lines` truncates every line after the first).
    expect(
      table.querySelector("[data-hide-narrow], [data-lines], .truncate"),
    ).toBeNull();
    // The count sits in the section head, beside the title it counts.
    expect(
      screen
        .getByRole("region", { name: "운영자 프로필" })
        .querySelector("[data-slot=badge]")?.textContent,
    ).toBe("2개");
    expect(
      screen.getByText("아직 워크스페이스 프로필이 없습니다"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "프로필 만들기" })).toBeDefined();
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("a member reads every profile but gets no way to change them", async () => {
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/profiles": () =>
        json(200, { items: [...PROFILES, version(1, "usable")] }),
    });
    const table = await screen.findByRole("table", {
      name: "워크스페이스 프로필",
    });
    expect(rows(table)).toEqual([
      ["이름", "바탕 프로필", "상태"],
      [
        "strict v1ws_acme_strict_v1",
        "coding-claudeclaude-sonnet-5",
        "사용 가능",
      ],
    ]);
    expect(
      screen.getByText("바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요"),
    ).toBeDefined();
    expect(
      screen.queryAllByRole("button", { name: "프로필 만들기" }).length,
    ).toBe(0);
    expect(screen.queryAllByRole("button", { name: "수정" }).length).toBe(0);
  });

  test("an owner narrows an operator profile into a new version", async () => {
    const server = catalog();
    const { api } = renderAt("/profiles", server.routes);
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "프로필 만들기",
    });
    expect(
      (within(editor).getByLabelText("바탕 프로필") as HTMLSelectElement).value,
    ).toBe("coding-claude");
    expect(
      within(editor)
        .getAllByRole("checkbox")
        .map((box) => [
          box.closest("[data-slot=field]")?.textContent,
          box.getAttribute("aria-checked"),
        ]),
    ).toEqual([
      ["claude-sonnet-5", "true"],
      ["claude-haiku-5", "false"],
      ["Read", "true"],
      ["Edit", "true"],
      ["Bash", "true"],
    ]);
    const mode = within(editor).getByLabelText(
      "권한 모드",
    ) as HTMLSelectElement;
    expect([...mode.options].map((option) => option.value)).toEqual([
      "acceptEdits",
      "default",
      "plan",
    ]);
    expect(
      (within(editor).getByLabelText("스크립트 상한") as HTMLSelectElement)
        .disabled,
    ).toBe(true);

    await user.type(within(editor).getByLabelText("이름"), "strict");
    expect(
      within(editor).getByText("저장할 버전의 id: ws_acme_strict_v1"),
    ).toBeDefined();
    await user.click(within(editor).getByRole("checkbox", { name: "Bash" }));
    await user.selectOptions(mode, "plan");
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );

    await screen.findByText("ws_acme_strict_v1 버전을 저장했습니다.");
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.body),
    ).toEqual([
      {
        name: "strict",
        base_profile_id: "coding-claude",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        tools: ["Read", "Edit"],
        permission_mode: "plan",
      },
    ]);
    await waitFor(() =>
      expect(
        screen.queryAllByRole("region", { name: "프로필 만들기" }).length,
      ).toBe(0),
    );
    const table = await screen.findByRole("table", {
      name: "워크스페이스 프로필",
    });
    await waitFor(() => expect(rows(table)).toHaveLength(2));
  });

  test("a name the server would refuse is caught before the request", async () => {
    const { api } = renderAt("/profiles", catalog().routes);
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "프로필 만들기",
    });
    await user.type(within(editor).getByLabelText("이름"), "Strict Review");
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );
    expect(
      await within(editor).findByText(
        "이름은 영문 소문자나 숫자로 시작하고, 영문 소문자·숫자·-로 40자까지 씁니다.",
      ),
    ).toBeDefined();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("a new version starts from the one it follows and keeps its name", async () => {
    const server = catalog([
      ...PROFILES,
      version(1, "usable", {
        tools: ["Read", "Edit"],
        permission_mode: "plan",
      }),
    ]);
    const { api } = renderAt("/profiles", server.routes);
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "수정" }));
    const editor = await screen.findByRole("region", {
      name: "strict 수정",
    });
    expect(within(editor).queryAllByLabelText("바탕 프로필").length).toBe(0);
    expect(
      (within(editor).getByLabelText("이름") as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(
      within(editor).getByText("저장할 버전의 id: ws_acme_strict_v2"),
    ).toBeDefined();
    await user.click(within(editor).getByRole("checkbox", { name: "Edit" }));
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );
    await screen.findByText("ws_acme_strict_v2 버전을 저장했습니다.");
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([
      {
        name: "strict",
        base_profile_id: "coding-claude",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        tools: ["Read"],
        permission_mode: "plan",
      },
    ]);
  });

  test("a name with several versions shows its latest, the earlier ones folded under it", async () => {
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () =>
        json(200, {
          items: [...PROFILES, version(1, "retired"), version(2, "usable")],
        }),
    });
    const table = await screen.findByRole("table", {
      name: "워크스페이스 프로필",
    });
    expect(rows(table).slice(1)).toEqual([
      [
        "strict v2 이전 버전 1개ws_acme_strict_v2",
        "coding-claudeclaude-sonnet-5",
        "사용 가능",
        "수정사용 중지",
      ],
    ]);
    expect(
      screen
        .getByRole("region", { name: "워크스페이스 프로필" })
        .querySelector("[data-slot=badge]")?.textContent,
    ).toBe("1개");
    const toggle = within(table).getByRole("button", {
      name: "이전 버전 1개",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const user = await setupUser();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows(table).slice(1)).toEqual([
      [
        "strict v2 이전 버전 1개ws_acme_strict_v2",
        "coding-claudeclaude-sonnet-5",
        "사용 가능",
        "수정사용 중지",
      ],
      [
        "strict v1ws_acme_strict_v1",
        "coding-claudeclaude-sonnet-5",
        "사용 중지됨",
        "",
      ],
    ]);
    await user.click(toggle);
    expect(rows(table)).toHaveLength(2);
  });

  test("a retired latest version still heads its name, and the earlier one keeps its actions", async () => {
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () =>
        json(200, {
          items: [...PROFILES, version(1, "usable"), version(2, "retired")],
        }),
    });
    const table = await screen.findByRole("table", {
      name: "워크스페이스 프로필",
    });
    const user = await setupUser();
    await user.click(
      within(table).getByRole("button", { name: "이전 버전 1개" }),
    );
    expect(rows(table).slice(1)).toEqual([
      [
        "strict v2 이전 버전 1개ws_acme_strict_v2",
        "coding-claudeclaude-sonnet-5",
        "사용 중지됨",
        "",
      ],
      [
        "strict v1ws_acme_strict_v1",
        "coding-claudeclaude-sonnet-5",
        "사용 가능",
        "수정사용 중지",
      ],
    ]);
  });

  test("a version whose base changed warns and is made again; one whose base is gone can only retire", async () => {
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () =>
        json(200, {
          items: [
            ...PROFILES,
            version(1, "base_changed"),
            {
              ...version(1, "base_missing"),
              id: "ws_acme_gone_v1",
              workspace: {
                ...(version(1, "base_missing").workspace as NonNullable<
                  ProfileSummary["workspace"]
                >),
                name: "gone",
                base_profile_id: "removed-profile",
              },
            },
          ],
        }),
    });
    expect(
      await screen.findByText("strict의 바탕 프로필이 바뀌었습니다"),
    ).toBeDefined();
    expect(screen.getByText("gone의 바탕 프로필이 없어졌습니다")).toBeDefined();
    const table = screen.getByRole("table", { name: "워크스페이스 프로필" });
    expect(rows(table)).toEqual([
      ["이름", "바탕 프로필", "상태", "동작"],
      [
        "gone v1ws_acme_gone_v1",
        "removed-profileclaude-sonnet-5",
        "바탕 프로필 없음",
        "사용 중지",
      ],
      [
        "strict v1ws_acme_strict_v1",
        "coding-claudeclaude-sonnet-5",
        "바탕 프로필 바뀜",
        "다시 만들기사용 중지",
      ],
    ]);
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "다시 만들기" }));
    expect(
      await screen.findByRole("region", { name: "strict 다시 만들기" }),
    ).toBeDefined();
  });

  test("retiring asks first, then leaves the version listed as retired", async () => {
    const items = [...PROFILES, version(1, "usable")];
    const { api } = renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => json(200, { items }),
      "POST /v1/workspace-profiles/ws_acme_strict_v1/retire": () => {
        items[2] = version(1, "retired");
        return json(200, { profile: items[2], receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "사용 중지 ws_acme_strict_v1",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "ws_acme_strict_v1 버전을 사용 중지할까요?",
    });
    expect(within(dialog).getByText(/되돌릴 수 없습니다/)).toBeDefined();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    await screen.findByText("ws_acme_strict_v1 버전을 사용 중지했습니다.");
    const table = screen.getByRole("table", { name: "워크스페이스 프로필" });
    await waitFor(() =>
      expect(rows(table)[1]).toEqual([
        "strict v1ws_acme_strict_v1",
        "coding-claudeclaude-sonnet-5",
        "사용 중지됨",
        "",
      ]),
    );
  });

  test("a save the base no longer allows says so", async () => {
    renderAt("/profiles", {
      ...catalog().routes,
      "POST /v1/workspace-profiles": () =>
        json(400, {
          error: {
            code: "BAD_REQUEST",
            message: "widens",
            retryable: false,
            request_id: "req-1",
            details: { reason_code: "widens_base", field: "tools" },
          },
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "프로필 만들기",
    });
    await user.type(within(editor).getByLabelText("이름"), "strict");
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );
    expect(
      await within(editor).findByText(
        "바탕 프로필이 허용하지 않는 값입니다. 목록을 다시 불러와 바탕 프로필을 확인하세요.",
      ),
    ).toBeDefined();
  });

  test("a base with more tools than one version holds is refused before the request", async () => {
    const wide: ProfileSummary = {
      ...(PROFILES[0] as ProfileSummary),
      tools: Array.from({ length: 65 }, (_, n) => `Tool${n}`),
    };
    const { api } = renderAt("/profiles", catalog([wide]).routes);
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "프로필 만들기",
    });
    await user.type(within(editor).getByLabelText("이름"), "wide");
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );
    expect(
      await within(editor).findByText(
        "한 프로필에는 모델 32개, 도구 64개까지 담습니다. 줄인 뒤 다시 저장하세요.",
      ),
    ).toBeDefined();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("a name longer than a version holds is named as such, not as a count", async () => {
    const long: ProfileSummary = {
      ...(PROFILES[0] as ProfileSummary),
      tools: ["Read", "x".repeat(201)],
    };
    const { api } = renderAt("/profiles", catalog([long]).routes);
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "프로필 만들기",
    });
    await user.type(within(editor).getByLabelText("이름"), "long");
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );
    expect(
      await within(editor).findByText(
        "프로필에는 200자 이하의 이름만 담습니다. 이름이 긴 모델이나 도구를 빼고 저장하세요.",
      ),
    ).toBeDefined();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("a late save reply leaves the editor opened meanwhile open", async () => {
    const base = catalog([...PROFILES, version(1, "usable")]);
    let reply = () => {};
    const replied = new Promise<void>((resolve) => {
      reply = resolve;
    });
    const create = base.routes["POST /v1/workspace-profiles"] as (
      request: Request,
    ) => Response | Promise<Response>;
    renderAt("/profiles", {
      ...base.routes,
      "POST /v1/workspace-profiles": async (request) => {
        await replied;
        return create(request);
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "프로필 만들기" }),
    );
    const first = await screen.findByRole("region", {
      name: "프로필 만들기",
    });
    await user.type(within(first).getByLabelText("이름"), "fresh");
    await user.click(
      within(first).getByRole("button", { name: "새 버전으로 저장" }),
    );
    await user.click(screen.getByRole("button", { name: "수정" }));
    await screen.findByRole("region", { name: "strict 수정" });
    reply();
    await screen.findByText("ws_acme_fresh_v1 버전을 저장했습니다.");
    expect(screen.getByRole("region", { name: "strict 수정" })).toBeDefined();
    expect(screen.queryAllByText("새 버전으로 저장").length).toBe(1);
  });

  test("a retire that fails after the role is lost still says so", async () => {
    let role: "owner" | "member" = "owner";
    let reply = () => {};
    const replied = new Promise<void>((resolve) => {
      reply = resolve;
    });
    const { services } = renderAt("/profiles", {
      ...catalog([...PROFILES, version(1, "usable")]).routes,
      "GET /v1/auth/me": () => json(200, role === "owner" ? me() : memberMe()),
      "POST /v1/workspace-profiles/ws_acme_strict_v1/retire": async () => {
        await replied;
        return apiError(500, "INTERNAL", "boom");
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "사용 중지 ws_acme_strict_v1",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    role = "member";
    await services.queryClient.invalidateQueries();
    await screen.findByText(
      "바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요",
    );
    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    reply();
    await waitFor(() => expect(screen.queryAllByRole("alert").length).toBe(1));
    expect(screen.getByRole("alert").textContent?.trim()).not.toBe("");
  });

  test("losing the manage role closes the open editor and retire dialog", async () => {
    let role: "owner" | "member" = "owner";
    const { services } = renderAt("/profiles", {
      ...catalog([...PROFILES, version(1, "usable")]).routes,
      "GET /v1/auth/me": () => json(200, role === "owner" ? me() : memberMe()),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "프로필 만들기" }),
    );
    await screen.findByRole("region", { name: "프로필 만들기" });
    await user.click(
      screen.getByRole("button", { name: "사용 중지 ws_acme_strict_v1" }),
    );
    await screen.findByRole("dialog");
    role = "member";
    await services.queryClient.invalidateQueries();
    await screen.findByText(
      "바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요",
    );
    await waitFor(() => expect(screen.queryAllByRole("dialog").length).toBe(0));
    expect(screen.queryAllByText("새 버전으로 저장").length).toBe(0);
  });

  test("a failed read says so and asks again", async () => {
    let failing = true;
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: PROFILES }),
    });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    failing = false;
    retry.click();
    await screen.findByRole("table", { name: "운영자 프로필" });
  });

  test("an installation without profiles says so and offers nothing to narrow", async () => {
    renderAt("/profiles", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => json(200, { items: [] }),
    });
    await screen.findByText("이 설치에 실행 프로필이 없습니다.");
    await waitFor(() =>
      expect(
        screen.queryAllByRole("table", { name: "운영자 프로필" }).length,
      ).toBe(0),
    );
    expect(
      screen.queryAllByRole("button", { name: "프로필 만들기" }).length,
    ).toBe(0);
  });
});
