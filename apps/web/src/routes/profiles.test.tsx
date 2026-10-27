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
          items.filter((item) => item.workspace?.name === body.name).length + 1;
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
    expect(screen.getByText("프로필 2개")).toBeDefined();
    expect(screen.getByText("아직 좁힌 프로필이 없습니다")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "좁힌 프로필 만들기" }),
    ).toBeDefined();
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
      ["이름", "기준", "상태"],
      ["strictws_acme_strict_v1", "coding-claudeclaude-sonnet-5", "쓸 수 있음"],
    ]);
    expect(
      screen.getByText("바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요"),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "좁힌 프로필 만들기" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "새 판 만들기" })).toBeNull();
  });

  test("an owner narrows an operator profile into a new version", async () => {
    const server = catalog();
    const { api } = renderAt("/profiles", server.routes);
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "좁힌 프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "좁힌 프로필 만들기",
    });
    expect(
      (within(editor).getByLabelText("기준 프로필") as HTMLSelectElement).value,
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
      within(editor).getByText("저장하면 ws_acme_strict_v1 판이 생깁니다."),
    ).toBeDefined();
    await user.click(within(editor).getByRole("checkbox", { name: "Bash" }));
    await user.selectOptions(mode, "plan");
    await user.click(
      within(editor).getByRole("button", { name: "새 판으로 저장" }),
    );

    await screen.findByText("ws_acme_strict_v1 판을 만들었습니다.");
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
        screen.queryByRole("region", { name: "좁힌 프로필 만들기" }),
      ).toBeNull(),
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
      await screen.findByRole("button", { name: "좁힌 프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "좁힌 프로필 만들기",
    });
    await user.type(within(editor).getByLabelText("이름"), "Strict Review");
    await user.click(
      within(editor).getByRole("button", { name: "새 판으로 저장" }),
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
    await user.click(
      await screen.findByRole("button", { name: "새 판 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "strict 새 판 만들기",
    });
    expect(within(editor).queryByLabelText("기준 프로필")).toBeNull();
    expect(
      (within(editor).getByLabelText("이름") as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(
      within(editor).getByText("저장하면 ws_acme_strict_v2 판이 생깁니다."),
    ).toBeDefined();
    await user.click(within(editor).getByRole("checkbox", { name: "Edit" }));
    await user.click(
      within(editor).getByRole("button", { name: "새 판으로 저장" }),
    );
    await screen.findByText("ws_acme_strict_v2 판을 만들었습니다.");
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
      await screen.findByText("strict의 기준이 바뀌었습니다"),
    ).toBeDefined();
    expect(screen.getByText("gone의 기준이 없어졌습니다")).toBeDefined();
    const table = screen.getByRole("table", { name: "워크스페이스 프로필" });
    expect(rows(table)).toEqual([
      ["이름", "기준", "상태", "동작"],
      [
        "gonews_acme_gone_v1",
        "removed-profileclaude-sonnet-5",
        "기준 없음",
        "은퇴",
      ],
      [
        "strictws_acme_strict_v1",
        "coding-claudeclaude-sonnet-5",
        "기준 바뀜",
        "다시 만들기은퇴",
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
      await screen.findByRole("button", { name: "은퇴 ws_acme_strict_v1" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "ws_acme_strict_v1 판을 은퇴시킬까요?",
    });
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "은퇴" }));
    await screen.findByText("ws_acme_strict_v1 판을 은퇴시켰습니다.");
    const table = screen.getByRole("table", { name: "워크스페이스 프로필" });
    await waitFor(() =>
      expect(rows(table)[1]).toEqual([
        "strictws_acme_strict_v1",
        "coding-claudeclaude-sonnet-5",
        "은퇴",
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
      await screen.findByRole("button", { name: "좁힌 프로필 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "좁힌 프로필 만들기",
    });
    await user.type(within(editor).getByLabelText("이름"), "strict");
    await user.click(
      within(editor).getByRole("button", { name: "새 판으로 저장" }),
    );
    expect(
      await within(editor).findByText(
        "기준 프로필이 허용하지 않는 값입니다. 목록을 다시 불러와 기준을 확인하세요.",
      ),
    ).toBeDefined();
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
      expect(screen.queryByRole("table", { name: "운영자 프로필" })).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "좁힌 프로필 만들기" }),
    ).toBeNull();
  });
});
