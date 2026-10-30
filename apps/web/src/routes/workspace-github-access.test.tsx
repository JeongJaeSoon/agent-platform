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
  apps: { author: { permissions: PERMISSIONS }, reviewer: null },
});

const ceilingSwitch = (name: string) =>
  screen.getByRole("switch", { name: new RegExp(`^${name}`) });

describe("GitHub 연결 › App 권한과 최대 권한", () => {
  test("App 권한 표는 안내와 App 값을 줄마다 보이고, 안내보다 넓은 권한은 경고한다", async () => {
    renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
      [`GET ${APP}`]: () => json(200, APP_BODY),
      [`GET ${SETTINGS}`]: () => json(200, settingsOf()),
    });
    const card = (
      await screen.findByRole("heading", { name: "App 권한" })
    ).closest("section") as HTMLElement;
    expect(
      within(card).getByText("작성용 App이 안내보다 넓은 권한을 가졌습니다"),
    ).toBeDefined();
    expect(within(card).getByText(/^administration 쓰기\./)).toBeDefined();
    expect(within(card).getByText("App 쓰기 · 안내보다 넓음")).toBeDefined();
    // The defaults and the optional ones the App holds read as matching.
    expect(within(card).getAllByText("App 쓰기")).toHaveLength(3);
    expect(within(card).getByText("App 읽기")).toBeDefined();
    // Optional ones it lacks read as absent, not as a fault.
    expect(within(card).getAllByText("App에 없음")).toHaveLength(3);
  });

  test("소유자가 Actions를 끄면 확인 대화 상자가 앞 릴리스 세션까지 거절된다고 말하고, 확인해야 보낸다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
      [`GET ${APP}`]: () => json(200, APP_BODY),
      [`GET ${SETTINGS}`]: () => json(200, settingsOf()),
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

  test("관리자가 올리는 변경은 묻지 않고 보내며, App에 없는 권한과 리뷰용 App 없음을 함께 알린다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
      [`GET ${APP}`]: () => json(200, APP_BODY),
      [`GET ${SETTINGS}`]: () => json(200, settingsOf()),
      [`PUT ${SETTINGS}`]: () =>
        json(200, settingsOf({ ...CEILING, workflows: true }, 4)),
    });
    const user = await setupUser();
    // checks, issues and workflows are not on the App.
    expect(
      await screen.findAllByText(
        "App에 권한 없음 · 허용해도 GitHub가 토큰 발급을 거절합니다.",
      ),
    ).toHaveLength(3);
    expect(
      screen.getAllByText(
        "App에 권한 없음 · 허용해도 GitHub가 토큰 발급을 거절합니다.",
      ),
    ).toHaveLength(3);
    expect(
      screen.getByText("리뷰용 App 없음 · 허용해도 리뷰 요청은 거절됩니다."),
    ).toBeDefined();
    await user.click(ceilingSwitch("워크플로 파일 수정"));
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "최대 권한을 저장했습니다.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ ceiling: { ...CEILING, workflows: true }, revision: 3 }]);
  });

  test("다른 사람이 먼저 바꿨으면 그 값을 다시 읽어 보이고 다시 저장하라고 안내한다", async () => {
    let revision = 3;
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
      [`GET ${APP}`]: () => json(200, APP_BODY),
      [`GET ${SETTINGS}`]: () =>
        json(
          200,
          revision === 3
            ? settingsOf()
            : settingsOf({ ...CEILING, issues: true }, revision),
        ),
      [`PUT ${SETTINGS}`]: () => {
        revision = 4;
        return apiError(409, "REVISION_CONFLICT", "server words");
      },
    });
    const user = await setupUser();
    await waitFor(() =>
      expect(ceilingSwitch("검사 결과 쓰기").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    await user.click(ceilingSwitch("검사 결과 쓰기"));
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "다른 사람이 먼저 최대 권한을 바꿨습니다. 지금 저장된 값을 다시 불러왔으니 확인하고 다시 저장하세요.",
    );
    // The draft is dropped for what is saved now.
    expect(ceilingSwitch("이슈 쓰기").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(ceilingSwitch("검사 결과 쓰기").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(
      api.calls.filter((c) => c.method === "GET" && c.path === SETTINGS),
    ).toHaveLength(2);
    expect(screen.queryByText("server words")).toBeNull();
  });

  test("고치는 사이 다시 읽혀도 고치기 시작한 revision으로 보내 남의 변경을 덮지 않는다", async () => {
    let reads = 0;
    const { api, services } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
      [`GET ${APP}`]: () => json(200, APP_BODY),
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
      expect(ceilingSwitch("이슈 쓰기").hasAttribute("disabled")).toBe(false),
    );
    await user.click(ceilingSwitch("이슈 쓰기"));
    // Someone else turned Actions off; the screen reads it again mid-edit.
    await services.queryClient.refetchQueries();
    await waitFor(() => expect(reads).toBe(2));
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByRole("alert");
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ ceiling: { ...CEILING, issues: true }, revision: 3 }]);
  });

  test("App을 지우면 설정이 아직 옛 App을 말해도 권한 표는 사라지고, 설정을 다시 읽는다", async () => {
    let deleted = false;
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
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
      [`GET ${SETTINGS}`]: () => json(200, settingsOf()),
      [`DELETE ${APP}`]: () => {
        deleted = true;
        return json(200, {
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        });
      },
    });
    const user = await setupUser();
    await screen.findByRole("heading", { name: "App 권한" });
    await user.click(screen.getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await within(screen.getByRole("region", { name: "GitHub App" })).findByText(
      "등록 안 됨",
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "App 권한" })).toBeNull(),
    );
    const settingsReads = () =>
      api.calls.filter((c) => c.method === "GET" && c.path === SETTINGS).length;
    await waitFor(() => expect(settingsReads()).toBe(2));
  });

  test("구성원은 권한 표와 상한을 읽기만 하고, 스위치는 잠기고 저장 버튼이 없다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET ${SETTINGS}`]: () => json(200, settingsOf()),
    });
    await screen.findByText("작성용 App이 안내보다 넓은 권한을 가졌습니다");
    for (const name of [
      "리뷰 승인",
      "Actions 실행",
      "검사 결과 쓰기",
      "이슈 쓰기",
      "워크플로 파일 수정",
    ])
      expect(ceilingSwitch(name).hasAttribute("disabled")).toBe(true);
    expect(ceilingSwitch("Actions 실행").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("읽기 전용")).toBeDefined();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(api.calls.some((c) => c.path === APP)).toBe(false);
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("바꾼 것이 없으면 저장해도 보내지 않고, 되돌리기는 저장된 값으로 돌린다", async () => {
    const { api } = renderAt(PATH, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${REVIEWER}`]: () => json(200, NO_REVIEWER),
      [`GET ${APP}`]: () => json(200, APP_BODY),
      [`GET ${SETTINGS}`]: () => json(200, settingsOf()),
    });
    const user = await setupUser();
    await waitFor(() =>
      expect(ceilingSwitch("이슈 쓰기").hasAttribute("disabled")).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.click(ceilingSwitch("이슈 쓰기"));
    await user.click(screen.getByRole("button", { name: "되돌리기" }));
    expect(ceilingSwitch("이슈 쓰기").getAttribute("aria-checked")).toBe(
      "false",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
    cleanup();
  });
});
