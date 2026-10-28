import { describe, expect, test } from "bun:test";
import type {
  AgentListItem,
  CreateWorkspaceProfileRequest,
  ProfileSummary,
  WorkspaceProfileState,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  json,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const RECEIPT_ID = "00000000-0000-4000-8000-000000000001";

const OPERATOR: ProfileSummary = {
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
};

function version(n: number, state: WorkspaceProfileState): ProfileSummary {
  return {
    ...OPERATOR,
    id: `ws_acme_strict_v${n}`,
    source: "workspace",
    models: ["claude-sonnet-5"],
    tools: n === 1 ? ["Read"] : ["Read", "Edit"],
    permission_mode: "default",
    workspace: {
      name: "strict",
      version: n,
      base_profile_id: "coding-claude",
      state,
      created_at: `2026-10-2${n}T00:00:00.000Z`,
      retired_at: state === "retired" ? "2026-10-27T00:00:00.000Z" : null,
    },
  };
}

function agent(
  n: number,
  name: string,
  profile: string | null,
  release: string | null,
): AgentListItem {
  return {
    id: `5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8${n}`,
    workspace_id: WORKSPACE_ID,
    slug: `agent-${n}`,
    name,
    status: "active",
    active_release_id: release,
    activation_revision: release === null ? -1 : 0,
    created_by: USER_ID,
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
    summary: {
      version: {
        version_no: n,
        role: "역할",
        instructions: "지시",
        mcp_servers: [],
        credential_refs: [],
      },
      runtime_profile_id: profile,
      bound_credential_refs: [],
      admins: [],
      needs_input_count: 0,
      running_count: 0,
    },
  };
}

const RELEASE = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const AGENTS = [
  agent(1, "결제 담당", "ws_acme_strict_v2", RELEASE),
  agent(2, "리뷰 담당", "ws_acme_strict_v1", RELEASE),
  agent(3, "초안 담당", null, null),
];

function catalog(
  signedIn = me(),
  start = [OPERATOR, version(1, "usable"), version(2, "usable")],
) {
  const items = [...start];
  return {
    "GET /v1/auth/me": () => json(200, signedIn),
    "GET /v1/profiles": () => json(200, { items }),
    "GET /v1/agents": () => json(200, { items: AGENTS, next_cursor: null }),
    "POST /v1/workspace-profiles": async (request: Request) => {
      const body = (await request.json()) as CreateWorkspaceProfileRequest;
      const n =
        items.filter((item) => item.workspace?.name === body.name).length + 1;
      const made: ProfileSummary = {
        ...version(n, "usable"),
        id: `ws_acme_${body.name}_v${n}`,
        tools: body.tools,
        permission_mode: body.permission_mode,
        workspace: {
          ...(version(n, "usable").workspace as NonNullable<
            ProfileSummary["workspace"]
          >),
          name: body.name,
        },
      };
      items.push(made);
      return json(201, { profile: made, receipt_id: RECEIPT_ID });
    },
  };
}

const values = () =>
  Object.fromEntries(
    Array.from(document.querySelectorAll("dt"), (term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]),
  );

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      Array.from(row.querySelectorAll('[role="cell"]'), (cell) =>
        cell.textContent?.trim(),
      ),
    );

describe("실행 프로필 상세", () => {
  test("a workspace row opens its version with settings, history and the agents on it", async () => {
    const { history } = renderAt("/profiles", catalog());
    const user = await setupUser();
    await user.click(
      await screen.findByRole("link", {
        name: "ws_acme_strict_v2 자세히 보기",
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(history.location.pathname).toBe("/profiles/ws_acme_strict_v2");
    expect(values()).toEqual({
      id: "ws_acme_strict_v2",
      "바탕 프로필": "coding-claude",
      "기본 모델": "claude-sonnet-5",
      "고를 수 있는 모델": "claude-sonnet-5",
      도구: "ReadEdit",
      "권한 모드": "default",
      "실행 환경": "Claude Agent SDK 0.3.270 · 저장소 필요 · 비용 집계",
      "만든 때": expect.any(String),
    });
    expect(
      cells(screen.getByRole("table", { name: "버전 기록" })).map((row) =>
        row.slice(0, 2),
      ),
    ).toEqual([
      ["v2 지금 보는 버전ws_acme_strict_v2", "사용 가능"],
      ["v1ws_acme_strict_v1", "사용 가능"],
    ]);
    // Only the agent whose active release names v2.
    const agents = await screen.findByRole("table", {
      name: "이 프로필을 쓰는 에이전트",
    });
    expect(cells(agents)).toEqual([["결제 담당", "에이전트 v1"]]);
    expect(
      within(agents)
        .getByRole("link", { name: "결제 담당의 릴리스 보기" })
        .getAttribute("href"),
    ).toBe(`/agents/${AGENTS[0]?.id}?tab=release`);

    await user.click(
      screen.getByRole("link", { name: "ws_acme_strict_v1 자세히 보기" }),
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe("/profiles/ws_acme_strict_v1"),
    );
    await waitFor(() =>
      expect(
        cells(screen.getByRole("table", { name: "이 프로필을 쓰는 에이전트" })),
      ).toEqual([["리뷰 담당", "에이전트 v2"]]),
    );
  });

  test("수정 opens the editor on this version's values and saving opens the new version", async () => {
    const { api, history } = renderAt("/profiles/ws_acme_strict_v1", catalog());
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "수정" }));
    const editor = await screen.findByRole("region", { name: "strict 수정" });
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
      ["Edit", "false"],
      ["Bash", "false"],
    ]);
    expect(
      within(editor).getByText("저장할 버전의 id: ws_acme_strict_v3"),
    ).toBeDefined();
    expect(within(editor).getByText(/새 버전으로 저장합니다/)).toBeDefined();
    await user.click(within(editor).getByRole("checkbox", { name: "Edit" }));
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );

    await screen.findByText("ws_acme_strict_v3 버전을 저장했습니다.");
    expect(history.location.pathname).toBe("/profiles/ws_acme_strict_v3");
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
        permission_mode: "default",
      },
    ]);
    expect(screen.queryByRole("region", { name: "strict 수정" })).toBeNull();
    await waitFor(() =>
      expect(
        cells(screen.getByRole("table", { name: "버전 기록" }))[0]?.[0],
      ).toBe("v3 지금 보는 버전ws_acme_strict_v3"),
    );
  });

  test("a member reads the detail without edit and without the agent list", async () => {
    const { api } = renderAt(
      "/profiles/ws_acme_strict_v2",
      catalog(memberMe()),
    );
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(values()["도구"]).toBe("ReadEdit");
    expect(screen.queryByRole("button", { name: "수정" })).toBeNull();
    expect(
      screen.getByText("바꾸려면 워크스페이스 소유자나 관리자에게 요청하세요"),
    ).toBeDefined();
    expect(
      screen.getByText(
        "에이전트 목록은 에이전트를 관리할 수 있는 사람만 봅니다",
      ),
    ).toBeDefined();
    expect(api.calls.some((call) => call.path === "/v1/agents")).toBe(false);
  });

  test("an operator row opens its detail", async () => {
    const { history } = renderAt("/profiles", catalog());
    const user = await setupUser();
    await user.click(
      await screen.findByRole("link", { name: "coding-claude 자세히 보기" }),
    );
    await screen.findByRole("heading", { level: 1, name: "coding-claude" });
    expect(history.location.pathname).toBe("/profiles/coding-claude");
    expect(values()["도구"]).toBe("ReadEditBash");
    expect(screen.queryByRole("table", { name: "버전 기록" })).toBeNull();
    await screen.findByText("지금 이 프로필을 쓰는 에이전트가 없습니다.");

    await user.click(
      screen.getByRole("button", { name: "이 프로필로 만들기" }),
    );
    const editor = await screen.findByRole("region", { name: "프로필 만들기" });
    expect(
      (within(editor).getByLabelText("이름") as HTMLInputElement).value,
    ).toBe("");
    await user.type(within(editor).getByLabelText("이름"), "fresh");
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );
    await screen.findByText("ws_acme_fresh_v1 버전을 저장했습니다.");
    expect(history.location.pathname).toBe("/profiles/ws_acme_fresh_v1");
    expect(values()["바탕 프로필"]).toBe("coding-claude");
  });

  test("opening another version closes the editor started on this one", async () => {
    const { api } = renderAt("/profiles/ws_acme_strict_v1", catalog());
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "수정" }));
    await screen.findByRole("region", { name: "strict 수정" });
    await user.click(
      screen.getByRole("link", { name: "ws_acme_strict_v2 자세히 보기" }),
    );
    await waitFor(() => expect(values().id).toBe("ws_acme_strict_v2"));
    expect(screen.queryByRole("region", { name: "strict 수정" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "수정" }));
    const editor = await screen.findByRole("region", { name: "strict 수정" });
    // v2's tools, not v1's.
    expect(
      within(editor)
        .getByRole("checkbox", { name: "Edit" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  test("a version whose base changed offers 다시 만들기; a retired one offers nothing", async () => {
    // The operator dropped Edit since v2 was made from it.
    const changed = { ...OPERATOR, tools: ["Read", "Bash"] };
    const start = [changed, version(1, "retired"), version(2, "base_changed")];
    const { api, history } = renderAt(
      "/profiles/ws_acme_strict_v2",
      catalog(me(), start),
    );
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "다시 만들기" }),
    );
    const editor = await screen.findByRole("region", {
      name: "strict 다시 만들기",
    });
    expect(screen.queryByRole("button", { name: "수정" })).toBeNull();
    await user.click(
      within(editor).getByRole("button", { name: "새 버전으로 저장" }),
    );
    await screen.findByText("ws_acme_strict_v3 버전을 저장했습니다.");
    expect(history.location.pathname).toBe("/profiles/ws_acme_strict_v3");
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => (call.body as CreateWorkspaceProfileRequest).tools),
    ).toEqual([["Read"]]);

    await user.click(
      screen.getByRole("link", { name: "ws_acme_strict_v1 자세히 보기" }),
    );
    await waitFor(() => expect(values().id).toBe("ws_acme_strict_v1"));
    expect(values()["사용 중지한 때"]).toEqual(expect.any(String));
    expect(screen.queryByRole("button", { name: "수정" })).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 만들기" })).toBeNull();
  });

  test("a version whose base is gone offers no edit", async () => {
    const orphan: ProfileSummary = {
      ...version(1, "base_missing"),
      workspace: {
        ...(version(1, "base_missing").workspace as NonNullable<
          ProfileSummary["workspace"]
        >),
        base_profile_id: "gone",
      },
    };
    renderAt("/profiles/ws_acme_strict_v1", catalog(me(), [OPERATOR, orphan]));
    await screen.findByRole("heading", { level: 1, name: "strict" });
    // In the title and in the history row.
    expect(screen.getAllByText("바탕 프로필 없음")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "수정" })).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 만들기" })).toBeNull();
  });

  const RETIRED: ProfileSummary = {
    ...OPERATOR,
    installation: {
      name: OPERATOR.id,
      version: 1,
      origin: "console",
      state: "retired",
      connection_id: null,
      title_model: null,
      project_settings: { claude_md: false },
      previous_id: null,
      created_by: null,
      created_at: "2026-10-27T00:00:00.000Z",
      retired_by: null,
      retired_at: "2026-10-27T01:00:00.000Z",
    },
  };

  test("a ceiling that does not run here offers nothing to make from it", async () => {
    renderAt("/profiles/coding-claude", catalog(me(), [RETIRED]));
    // The heading already shows the id while loading.
    await waitFor(() => expect(values()["도구"]).toBe("ReadEditBash"));
    expect(
      screen.queryAllByRole("button", { name: "이 프로필로 만들기" }),
    ).toHaveLength(0);
  });

  test("a version over a ceiling that does not run here offers no new version", async () => {
    renderAt(
      "/profiles/ws_acme_strict_v1",
      catalog(me(), [RETIRED, version(1, "usable")]),
    );
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(values()["바탕 프로필"]).toBe("coding-claude");
    expect(screen.queryAllByRole("button", { name: "수정" })).toHaveLength(0);
  });

  test("an unknown id says the profile is not there", async () => {
    renderAt("/profiles/nope", catalog());
    await screen.findByRole("heading", {
      level: 1,
      name: "프로필을 찾을 수 없습니다",
    });
  });
});
