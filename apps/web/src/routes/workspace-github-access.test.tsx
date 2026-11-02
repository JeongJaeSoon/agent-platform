import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { cleanup, renderAt, screen, waitFor, within } = await appHarness();

const PATH = "/settings/workspace/github";
const APP = `/v1/workspaces/${WORKSPACE_ID}/github-apps/author`;
const REVIEWER = `/v1/workspaces/${WORKSPACE_ID}/github-apps/reviewer`;
const NO_REVIEWER = {
  github_app: null,
  check: null,
  installations: [],
  repositories: [],
};
const SETTINGS = `/v1/workspaces/${WORKSPACE_ID}/github-settings`;
const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  actions: "write",
  administration: "write",
} as const;
const APP_BODY = {
  github_app: {
    app_id: 4242,
    slug: "werft-test",
    name: "werft test",
    html_url: "https://github.com/apps/werft-test",
    private_key: { updated_at: "2026-10-30T05:00:00.000Z", updated_by: null },
    created_at: "2026-10-30T05:00:00.000Z",
    updated_at: "2026-10-30T05:00:00.000Z",
    permissions: PERMISSIONS,
    permissions_checked_at: "2026-10-30T05:00:00.000Z",
  },
  check: { state: "ok" },
  installations: [],
  repositories: [],
};
const CEILING = {
  workflows: false,
  actions: true,
  checks: false,
  issues: false,
  review: false,
};
const settingsOf = (ceiling = CEILING, revision = 3) => ({
  ceiling,
  revision,
  agents_using: { workflows: 0, actions: 2, checks: 0, issues: 0, review: 0 },
  oauth: {
    client_id: "Iv23liapp",
    client_secret_set: false,
    callback_url: null,
  },
  connections: [],
  apps: { author: { permissions: PERMISSIONS }, reviewer: null },
});
const ownerRoutes = (settings = settingsOf()) => ({
  "GET /v1/auth/me": () => json(200, me()),
  [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
  [`GET ${APP}`]: () => json(200, APP_BODY),
  [`GET ${SETTINGS}`]: () => json(200, settings),
});

const ceilingSwitch = (name: string) =>
  screen.getByRole("switch", { name: new RegExp(`^${name}`) });
const permissionTable = () => screen.findByRole("table", { name: /^권한/ });
/** Each body row as [name, need, App, status]. */
const tableRows = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent?.trim()),
    );
const ceilingRow = (name: string) =>
  ceilingSwitch(name).closest("[data-slot=setting-row]") as HTMLElement;

describe("GitHub 연결 › App 권한과 최대 권한", () => {
  test("권한 표는 필요·App·상태를 한 줄에 보이고, 문제 있는 행이 먼저 온다", async () => {
    renderAt(PATH, ownerRoutes());
    const table = await permissionTable();
    expect(tableRows(table)).toEqual([
      [
        "Administrationadministration · 플랫폼이 쓰지 않음",
        "—없음",
        "쓰기",
        "필요보다 넓음",
      ],
      ["저장소 내용contents · 기본", "쓰기", "쓰기", "맞음"],
      ["Pull requestpull_requests · 기본", "쓰기", "쓰기", "맞음"],
      ["메타데이터metadata · 기본", "읽기", "읽기", "맞음"],
      ["Actionsactions · Actions 실행에 씀", "쓰기", "쓰기", "맞음"],
    ]);
    // Wider than the platform could ever use: the alert says what a leak costs.
    expect(
      screen.getByText("작성용 App이 안내보다 넓은 권한을 가졌습니다"),
    ).toBeDefined();
    expect(screen.getByText(/^administration 쓰기\./)).toBeDefined();
  });

  test("필요는 최대 권한에서 켠 기능으로 정하고, App에 없거나 부족한 권한을 맨 위에 둔다", async () => {
    renderAt(
      PATH,
      ownerRoutes(
        settingsOf({ ...CEILING, actions: false, workflows: true }, 3),
      ),
    );
    const table = await permissionTable();
    const rows = tableRows(table);
    expect(rows[0]).toEqual([
      "Workflowsworkflows · 워크플로 파일 수정에 씀",
      "쓰기",
      "—없음",
      "App에 없음",
    ]);
    // Actions is off, so its write is now more than the platform asks for.
    expect(rows).toContainEqual([
      "Actionsactions · Actions 실행을 켜면 씀",
      "—없음",
      "쓰기",
      "필요보다 넓음",
    ]);
    expect(rows.at(-1)?.[3]).toBe("맞음");
  });

  test("최대 권한은 App별로 묶이고, 행마다 필요한 App 권한과 보유 여부를 보인다", async () => {
    renderAt(PATH, ownerRoutes());
    await waitFor(() =>
      expect(ceilingSwitch("Actions 실행").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.getByText("werft test의 권한으로")).toBeDefined();
    expect(screen.getByText("리뷰 승인용 App의 권한으로")).toBeDefined();
    expect(
      within(ceilingRow("Actions 실행")).getByText(
        "필요한 App 권한: Actions 쓰기 · 있음",
      ),
    ).toBeDefined();
    const workflows = ceilingRow("워크플로 파일 수정");
    expect(within(workflows).getByText("App에 권한 부족")).toBeDefined();
    expect(
      within(workflows).getByText(/필요한 App 권한: Workflows 쓰기/)
        .textContent,
    ).toBe("필요한 App 권한: Workflows 쓰기 · App에 없음");
    // No work stands behind checks or issues, so they are not offered.
    expect(screen.queryByRole("switch", { name: /검사 결과 쓰기/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /이슈 쓰기/ })).toBeNull();
    // A review needs a reviewer App first.
    expect(ceilingSwitch("PR 리뷰").hasAttribute("disabled")).toBe(true);
  });

  test("소유자가 Actions를 끄면 확인 대화 상자가 앞 릴리스 세션까지 거절된다고 말하고, 확인해야 보낸다", async () => {
    const { api } = renderAt(PATH, {
      ...ownerRoutes(),
      [`PUT ${SETTINGS}`]: () =>
        json(200, settingsOf({ ...CEILING, actions: false }, 4)),
    });
    const user = await setupUser();
    await waitFor(() =>
      expect(ceilingSwitch("Actions 실행").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    await user.click(ceilingSwitch("Actions 실행"));
    await user.click(screen.getByRole("button", { name: "저장" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "Actions 실행(활성 릴리스에서 켠 에이전트 2개) 권한을 끕니다. 앞 릴리스로 도는 세션도 다음 GitHub 요청부터 거절됩니다.",
    );
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "낮추고 저장",
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "최대 권한을 저장했습니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ ceiling: { ...CEILING, actions: false }, revision: 3 }]);
    expect(ceilingSwitch("Actions 실행").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  test("관리자가 올리는 변경은 묻지 않고 보내고, 목록에서 뺀 검사·이슈 값은 저장된 그대로 보낸다", async () => {
    const saved = { ...CEILING, checks: true };
    const { api } = renderAt(PATH, {
      ...ownerRoutes(settingsOf(saved)),
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      [`PUT ${SETTINGS}`]: () =>
        json(200, settingsOf({ ...saved, workflows: true }, 4)),
    });
    const user = await setupUser();
    await waitFor(() =>
      expect(ceilingSwitch("워크플로 파일 수정").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    await user.click(ceilingSwitch("워크플로 파일 수정"));
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "최대 권한을 저장했습니다.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ ceiling: { ...saved, workflows: true }, revision: 3 }]);
  });

  test("다른 사람이 먼저 바꿨으면 그 값을 다시 읽어 보이고 다시 저장하라고 안내한다", async () => {
    let revision = 3;
    const { api } = renderAt(PATH, {
      ...ownerRoutes(),
      [`GET ${SETTINGS}`]: () =>
        json(
          200,
          revision === 3
            ? settingsOf()
            : settingsOf({ ...CEILING, actions: false }, revision),
        ),
      [`PUT ${SETTINGS}`]: () => {
        revision = 4;
        return apiError(409, "REVISION_CONFLICT", "server words");
      },
    });
    const user = await setupUser();
    await waitFor(() =>
      expect(ceilingSwitch("워크플로 파일 수정").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    await user.click(ceilingSwitch("워크플로 파일 수정"));
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "다른 사람이 먼저 최대 권한을 바꿨습니다. 지금 저장된 값을 다시 불러왔으니 확인하고 다시 저장하세요.",
    );
    // The draft is dropped for what is saved now.
    expect(ceilingSwitch("Actions 실행").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(
      ceilingSwitch("워크플로 파일 수정").getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      api.calls.filter((c) => c.method === "GET" && c.path === SETTINGS),
    ).toHaveLength(2);
    expect(screen.queryByText("server words")).toBeNull();
  });

  test("고치는 사이 다시 읽혀도 고치기 시작한 revision으로 보내 남의 변경을 덮지 않는다", async () => {
    let reads = 0;
    const { api, services } = renderAt(PATH, {
      ...ownerRoutes(),
      [`GET ${SETTINGS}`]: () => {
        reads += 1;
        return json(
          200,
          reads === 1
            ? settingsOf()
            : settingsOf({ ...CEILING, actions: false }, 4),
        );
      },
      [`PUT ${SETTINGS}`]: () =>
        apiError(409, "REVISION_CONFLICT", "server words"),
    });
    const user = await setupUser();
    await waitFor(() =>
      expect(ceilingSwitch("워크플로 파일 수정").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    await user.click(ceilingSwitch("워크플로 파일 수정"));
    // Someone else turned Actions off; the screen reads it again mid-edit.
    await services.queryClient.refetchQueries();
    await waitFor(() => expect(reads).toBe(2));
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByRole("alert");
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ ceiling: { ...CEILING, workflows: true }, revision: 3 }]);
  });

  test("App을 지우면 설정이 아직 옛 App을 말해도 권한 표는 사라지고, 설정을 다시 읽는다", async () => {
    let deleted = false;
    const { api } = renderAt(PATH, {
      ...ownerRoutes(),
      [`GET ${APP}`]: () =>
        json(
          200,
          deleted
            ? {
                github_app: null,
                check: null,
                installations: [],
                repositories: [],
              }
            : APP_BODY,
        ),
      // A settings read that lags the delete: only the App read says it is gone.
      [`DELETE ${APP}`]: () => {
        deleted = true;
        return json(200, {
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        });
      },
    });
    const user = await setupUser();
    await permissionTable();
    await user.click(screen.getByRole("button", { name: "GitHub App 삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await within(screen.getByRole("region", { name: "GitHub App" })).findByText(
      "등록 안 됨",
    );
    await waitFor(() =>
      expect(screen.queryByRole("table", { name: /^권한/ })).toBeNull(),
    );
    expect(screen.getByText("작성용 App의 권한으로")).toBeDefined();
    const settingsReads = () =>
      api.calls.filter((c) => c.method === "GET" && c.path === SETTINGS).length;
    await waitFor(() => expect(settingsReads()).toBe(2));
  });

  test("구성원은 권한 표와 상한을 읽기만 하고, 스위치는 잠기고 저장 버튼이 없다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET ${SETTINGS}`]: () => json(200, settingsOf()),
    });
    await permissionTable();
    expect(
      screen.getByText("작성용 App이 안내보다 넓은 권한을 가졌습니다"),
    ).toBeDefined();
    for (const name of ["PR 리뷰", "Actions 실행", "워크플로 파일 수정"])
      expect(ceilingSwitch(name).hasAttribute("disabled")).toBe(true);
    expect(ceilingSwitch("Actions 실행").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("읽기 전용")).toBeDefined();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "연결 요약" })).toBeNull();
    expect(api.calls.some((c) => c.path === APP)).toBe(false);
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("바꾼 것이 없으면 저장해도 보내지 않고, 되돌리기는 저장된 값으로 돌린다", async () => {
    const { api } = renderAt(PATH, ownerRoutes());
    const user = await setupUser();
    await waitFor(() =>
      expect(ceilingSwitch("워크플로 파일 수정").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.click(ceilingSwitch("워크플로 파일 수정"));
    await user.click(screen.getByRole("button", { name: "되돌리기" }));
    expect(
      ceilingSwitch("워크플로 파일 수정").getAttribute("aria-checked"),
    ).toBe("false");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
    cleanup();
  });
});
