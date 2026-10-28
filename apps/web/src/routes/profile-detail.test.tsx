import { describe, expect, test } from "bun:test";
import type { AgentListItem, ProfileSummary } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import {
  ceiling,
  imported,
  RECEIPT_ID,
  version,
} from "../test-support/profiles.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const CODING = imported("coding-claude");

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
  start: ProfileSummary[] = [
    CODING,
    version(1, "usable"),
    version(2, "usable", { tools: ["Read", "Edit"] }),
  ],
  signedIn = me(),
) {
  const items = [...start];
  const retire = (id: string) => {
    const at = items.findIndex((item) => item.id === id);
    const item = items[at] as ProfileSummary;
    const retired: ProfileSummary = item.installation
      ? {
          ...item,
          installation: {
            ...item.installation,
            state: "retired",
            retired_by: USER_ID,
            retired_at: "2026-10-28T00:00:00.000Z",
          },
        }
      : {
          ...item,
          workspace: {
            ...(item.workspace as NonNullable<ProfileSummary["workspace"]>),
            state: "retired",
            retired_by: USER_ID,
            retired_at: "2026-10-28T00:00:00.000Z",
          },
        };
    items[at] = retired;
    return json(200, { profile: retired, receipt_id: RECEIPT_ID });
  };
  return {
    "GET /v1/auth/me": () => json(200, signedIn),
    "GET /v1/profiles": () => json(200, { items }),
    "GET /v1/agents": () => json(200, { items: AGENTS, next_cursor: null }),
    "POST /v1/workspace-profiles/ws_acme_strict_v2/retire": () =>
      retire("ws_acme_strict_v2"),
    "POST /v1/installation-profiles/op_wide_v2/retire": () =>
      retire("op_wide_v2"),
  };
}

/** The settings and record lists, term by term. */
const values = (title: string) =>
  Object.fromEntries(
    Array.from(
      screen.getByRole("region", { name: title }).querySelectorAll("dt"),
      (term) => [term.textContent, term.nextElementSibling?.textContent],
    ),
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

/** The page header's buttons: the second block beside the title, if any. */
const actions = () => {
  const header = document.querySelector("[data-slot=page-header]");
  const side = header?.querySelectorAll(":scope > div")[1];
  return side
    ? Array.from(side.querySelectorAll("a, button"), (item) => item.textContent)
    : [];
};

describe("실행 프로필 상세", () => {
  test("a workspace row opens its version with settings, record, history and the agents on it", async () => {
    renderAt("/profiles", catalog());
    const user = await setupUser();
    await user.click(
      await screen.findByRole("link", {
        name: "ws_acme_strict_v2 자세히 보기",
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(values("설정")).toEqual({
      id: "ws_acme_strict_v2",
      종류: "워크스페이스 프로필",
      "바탕 프로필": "coding-claude",
      런타임: "claude_agent_sdk 0.3.270",
      "기본 모델": "claude-sonnet-5",
      "고를 수 있는 모델": "claude-sonnet-5",
      도구: "ReadEdit",
      "권한 모드": "default",
      저장소: "저장소 필요",
      "허용할 저장소": "platform",
      비용: "비용 집계",
    });
    expect(values("기록")).toMatchObject({
      "만든 사람": `${USER_ID} (나)`,
    });
    expect(
      cells(screen.getByRole("table", { name: "버전 기록" })).map((row) =>
        row.slice(0, 2),
      ),
    ).toEqual([
      ["v2 지금 보는 버전ws_acme_strict_v2", "사용 가능"],
      ["v1ws_acme_strict_v1", "사용 가능"],
    ]);
    const agents = await screen.findByRole("table", {
      name: "이 프로필을 쓰는 에이전트",
    });
    expect(cells(agents)).toEqual([["결제 담당", "에이전트 v1"]]);
    expect(actions()).toEqual(["새 버전", "사용 중지"]);
  });

  test("새 버전 opens the creation page on this version", async () => {
    const { history } = renderAt("/profiles/ws_acme_strict_v2", catalog());
    const user = await setupUser();
    await user.click(await screen.findByRole("link", { name: "새 버전" }));
    await screen.findByRole("heading", { level: 1, name: "strict 새 버전" });
    expect(history.location.pathname).toBe("/profiles/new");
    expect(history.location.search).toContain("from=ws_acme_strict_v2");
    expect(history.location.search).toContain("mode=version");
  });

  test("retiring a version asks first, then shows it retired with who did it", async () => {
    const { api } = renderAt("/profiles/ws_acme_strict_v2", catalog());
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "사용 중지" }));
    const dialog = await screen.findByRole("dialog", {
      name: "ws_acme_strict_v2 버전을 사용 중지할까요?",
    });
    expect(within(dialog).getByText(/되돌릴 수 없습니다/)).toBeDefined();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    await screen.findByText("ws_acme_strict_v2 버전을 사용 중지했습니다.");
    await waitFor(() =>
      expect(values("기록")).toMatchObject({
        "사용 중지한 사람": `${USER_ID} (나)`,
      }),
    );
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual(["/v1/workspace-profiles/ws_acme_strict_v2/retire"]);
    expect(screen.queryAllByRole("button", { name: "사용 중지" }).length).toBe(
      0,
    );
  });

  test("a ceiling shows its definition, its record and the versions linked to it", async () => {
    renderAt(
      "/profiles/op_wide_v2",
      catalog([
        CODING,
        ceiling("wide", 1, {}, { previous_id: "coding-claude" }),
        ceiling("wide", 2, { permission_mode: "auto" }),
        version(1, "usable", {}, "op_wide_v2"),
      ]),
    );
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(values("설정")).toEqual({
      id: "op_wide_v2",
      종류: "설치 상한",
      연결: "anthropic",
      런타임: "claude_agent_sdk 0.3.270",
      "기본 모델": "claude-sonnet-5",
      "고를 수 있는 모델": "claude-sonnet-5claude-haiku-5",
      "제목 모델": "claude-haiku-5",
      도구: "ReadEditBash",
      "권한 모드": "auto",
      저장소: "저장소 필요",
      "허용할 저장소": "platform",
      비용: "비용 집계",
      "저장소의 CLAUDE.md 읽기": "켬",
    });
    expect(values("기록")).toEqual({
      출처: "콘솔에서 만듦",
      "만든 사람": `${USER_ID} (나)`,
      "만든 때": expect.any(String),
      "앞 버전": "op_wide_v1",
    });
    // The line runs back through v1 to the import it replaced.
    expect(
      cells(screen.getByRole("table", { name: "버전 기록" })).map(
        (row) => row[0],
      ),
    ).toEqual([
      "wide v2 지금 보는 버전op_wide_v2",
      "wide v1op_wide_v1",
      "coding-claude v1coding-claude",
    ]);
    expect(
      cells(
        screen.getByRole("table", {
          name: "이 상한 위의 워크스페이스 프로필",
        }),
      ),
    ).toEqual([["strict v1ws_acme_strict_v1", "사용 가능", "claude-sonnet-5"]]);
    expect(actions()).toEqual([
      "이 상한으로 프로필 만들기",
      "새 버전",
      "사용 중지",
    ]);
  });

  test("an earlier ceiling version offers no 새 버전, which only the latest takes", async () => {
    renderAt(
      "/profiles/op_wide_v1",
      catalog([CODING, ceiling("wide", 1), ceiling("wide", 2)]),
    );
    await screen.findByRole("region", { name: "기록" });
    expect(actions()).toEqual(["이 상한으로 프로필 만들기", "사용 중지"]);
  });

  test("a ceiling followed only under another name still offers 새 버전", async () => {
    renderAt(
      "/profiles/op_wide_v1",
      catalog([
        CODING,
        ceiling("wide", 1),
        ceiling("other", 1, {}, { previous_id: "op_wide_v1" }),
        ceiling("coding", 1, {}, { previous_id: "coding-claude" }),
      ]),
    );
    await screen.findByRole("region", { name: "기록" });
    expect(actions()).toEqual([
      "이 상한으로 프로필 만들기",
      "새 버전",
      "사용 중지",
    ]);
  });

  test("an imported ceiling with a successor still offers 새 버전 under a new name", async () => {
    renderAt(
      "/profiles/coding-claude",
      catalog([
        CODING,
        ceiling("coding", 1, {}, { previous_id: "coding-claude" }),
      ]),
    );
    await screen.findByRole("region", { name: "기록" });
    expect(actions()).toContain("새 버전");
  });

  test("an imported ceiling says where it came from", async () => {
    renderAt("/profiles/coding-claude", catalog());
    // The title is the id while it loads too; wait for the record itself.
    await screen.findByRole("region", { name: "기록" });
    expect(values("기록")).toEqual({
      출처: "설치 설정 파일에서 가져옴",
      "만든 사람": "설치 설정 파일",
      "만든 때": expect.any(String),
      "앞 버전": "없음",
    });
    expect(
      screen.getByRole("link", { name: "새 버전" }).getAttribute("href"),
    ).toBe("/profiles/new?kind=installation&from=coding-claude&mode=version");
  });

  test("an owner retires a ceiling, told that what runs on it keeps running", async () => {
    const { api } = renderAt(
      "/profiles/op_wide_v2",
      catalog([CODING, ceiling("wide", 1), ceiling("wide", 2)]),
    );
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "사용 중지" }));
    const dialog = await screen.findByRole("dialog", {
      name: "op_wide_v2 버전을 사용 중지할까요?",
    });
    expect(
      within(dialog).getByText(/그 위의 워크스페이스 프로필은 계속 동작합니다/),
    ).toBeDefined();
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    await screen.findByText("op_wide_v2 버전을 사용 중지했습니다.");
    expect(
      api.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual(["/v1/installation-profiles/op_wide_v2/retire"]);
    expect(
      await screen.findByText(
        /^사용 중지했습니다\. 이미 쓰는 release와 세션은/,
      ),
    ).toBeDefined();
  });

  test("a refused ceiling retire says only an owner may", async () => {
    renderAt("/profiles/op_wide_v2", {
      ...catalog([CODING, ceiling("wide", 2)]),
      "POST /v1/installation-profiles/op_wide_v2/retire": () =>
        apiError(403, "FORBIDDEN", "role"),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "사용 중지" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "사용 중지" }));
    expect(
      await within(dialog).findByText(
        "설치 상한은 워크스페이스 owner만 만들고 사용 중지할 수 있습니다.",
      ),
    ).toBeDefined();
  });

  test("an admin narrows a ceiling but neither versions nor retires it", async () => {
    renderAt(
      "/profiles/op_wide_v2",
      catalog([CODING, ceiling("wide", 2)], me(undefined, "admin")),
    );
    await screen.findByRole("heading", { level: 1, name: "wide" });
    expect(actions()).toEqual(["이 상한으로 프로필 만들기"]);
    expect(
      screen.getByText("설치 상한은 워크스페이스 owner만 바꿀 수 있습니다"),
    ).toBeDefined();
  });

  test("a member reads the detail without actions and without the agent list", async () => {
    renderAt("/profiles/ws_acme_strict_v2", catalog(undefined, memberMe()));
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(actions()).toEqual([]);
    expect(
      screen.getByText(
        "에이전트 목록은 에이전트를 관리할 수 있는 사람만 봅니다",
      ),
    ).toBeDefined();
  });

  test("a version whose base changed offers 다시 만들기 and says why; a retired one offers nothing", async () => {
    renderAt(
      "/profiles/ws_acme_strict_v1",
      catalog([CODING, version(1, "base_changed"), version(2, "retired")]),
    );
    await screen.findByRole("heading", { level: 1, name: "strict" });
    expect(actions()).toEqual(["다시 만들기", "사용 중지"]);
    expect(
      screen.getByRole("link", { name: "다시 만들기" }).getAttribute("href"),
    ).toBe("/profiles/new?kind=workspace&from=ws_acme_strict_v1&mode=remake");
    expect(
      screen.getByText(
        /^바탕 프로필 coding-claude가 이 버전을 만든 뒤 바뀌었습니다/,
      ),
    ).toBeDefined();
    const user = await setupUser();
    await user.click(
      screen.getByRole("link", { name: "ws_acme_strict_v2 자세히 보기" }),
    );
    await waitFor(() => expect(actions()).toEqual([]));
  });

  test("a ceiling that does not run here says why and is no base to make from", async () => {
    renderAt(
      "/profiles/coding-claude",
      catalog([imported("coding-claude", {}, "connection_missing")]),
    );
    expect(
      await screen.findByText(/^이 상한의 연결이 이 설치에 없어/),
    ).toBeDefined();
    expect(actions()).toEqual(["새 버전", "사용 중지"]);
  });

  test("an unknown id says the profile is not there", async () => {
    renderAt("/profiles/nope", catalog());
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "프로필을 찾을 수 없습니다",
      }),
    ).toBeDefined();
  });
});
