import { afterEach, describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  GITHUB_SETTINGS,
  githubSettings,
  json,
  me,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
const { githubNavigation } = await import("./workspace-github-new-app.tsx");

const PATH = "/settings/workspace/github";
const APP = `/v1/workspaces/${WORKSPACE_ID}/github-apps/author`;
const REVIEWER = `/v1/workspaces/${WORKSPACE_ID}/github-apps/reviewer`;
const START = `${APP}/manifest`;
const COMPLETE = `${APP}/manifest/complete`;
const UNSET = {
  github_app: null,
  check: null,
  installations: [],
  repositories: [],
  manifest_blocked: null,
};
const REGISTERED = {
  ...UNSET,
  github_app: {
    app_id: 4242,
    slug: "werft-test",
    name: "werft test",
    html_url: "https://github.com/apps/werft-test",
    private_key: { updated_at: "2026-10-30T05:00:00.000Z", updated_by: null },
    created_at: "2026-10-30T05:00:00.000Z",
    updated_at: "2026-10-30T05:00:00.000Z",
  },
  check: { state: "ok" },
};
const STARTED = {
  action_url:
    "https://github.com/organizations/acme/settings/apps/new?state=s1",
  manifest: '{"name":"werft-acme-1a2b"}',
  expires_at: "2026-11-01T10:00:00.000Z",
};
const refusal = (status: number, code: string, details: object) =>
  json(status, {
    error: {
      code,
      message: "server words",
      retryable: false,
      request_id: "req-1",
      details,
    },
  });

const posted: Array<{ url: string; manifest: string }> = [];
const assigned: string[] = [];
githubNavigation.post = (url, manifest) => {
  posted.push({ url, manifest });
};
githubNavigation.assign = (url) => {
  assigned.push(url);
};
afterEach(() => {
  posted.length = 0;
  assigned.length = 0;
});

const settingsRoutes = (app: object) => ({
  "GET /v1/auth/me": () => json(200, me()),
  [`GET ${GITHUB_SETTINGS}`]: () => json(200, githubSettings()),
  [`GET ${REVIEWER}`]: () => json(200, UNSET),
  [`GET ${APP}`]: () => json(200, app),
});

describe("새 GitHub App 만들기", () => {
  test("조직과 비공개가 기본이고, 조직 이름 없이는 보내지 않으며, 보낸 manifest를 GitHub로 POST한다", async () => {
    const { api } = renderAt(PATH, {
      ...settingsRoutes(UNSET),
      [`POST ${START}`]: () => json(200, STARTED),
    });
    const user = await setupUser();
    const card = within(
      await screen.findByRole("region", { name: "GitHub App" }),
    );
    expect(
      await card.findByRole("button", { name: "이미 있는 App 추가" }),
    ).toBeDefined();
    await user.click(
      await card.findByRole("button", { name: "새 App 만들기" }),
    );
    const login = await screen.findByLabelText("조직 이름");
    await waitFor(() => expect(document.activeElement === login).toBe(true));
    expect(
      (screen.getByRole("radio", { name: "조직" }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: "이 계정에서만 (비공개 App)" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    expect(
      await screen.findByText("GitHub 조직 이름을 적어 주세요."),
    ).toBeDefined();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);

    await user.type(login, "acme");
    await user.click(
      screen.getByRole("checkbox", { name: "Actions·워크플로 권한도 받기" }),
    );
    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      url: STARTED.action_url,
      manifest: STARTED.manifest,
    });
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([
      {
        owner: { kind: "organization", login: "acme" },
        public: false,
        actions: true,
        replace: false,
      },
    ]);
  });

  test("개인 계정과 공개를 고르면 그대로 보낸다", async () => {
    const { api } = renderAt(PATH, {
      ...settingsRoutes(UNSET),
      [`POST ${START}`]: () =>
        json(200, {
          ...STARTED,
          action_url: "https://github.com/settings/apps/new?state=s2",
        }),
    });
    const user = await setupUser();
    const card = within(
      await screen.findByRole("region", { name: "GitHub App" }),
    );
    await user.click(
      await card.findByRole("button", { name: "새 App 만들기" }),
    );
    await user.click(
      await screen.findByRole("radio", { name: "내 개인 계정" }),
    );
    expect(screen.queryByLabelText("조직 이름")).toBeNull();
    await user.click(
      screen.getByRole("radio", { name: "여러 조직에서 (공개 App)" }),
    );
    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([
      { owner: { kind: "user" }, public: true, actions: false, replace: false },
    ]);
  });

  test("CONSOLE_ORIGIN이 없으면 이유를 보이고 만들기를 막는다", async () => {
    const { api } = renderAt(PATH, {
      ...settingsRoutes({ ...UNSET, manifest_blocked: "console_origin_unset" }),
    });
    const user = await setupUser();
    const card = within(
      await screen.findByRole("region", { name: "GitHub App" }),
    );
    await user.click(
      await card.findByRole("button", { name: "새 App 만들기" }),
    );
    const submit = await screen.findByRole("button", {
      name: "GitHub에서 만들기",
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/CONSOLE_ORIGIN이 설정되지 않아/)).toBeDefined();
    expect(submit.getAttribute("aria-describedby")).toBeTruthy();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("App이 있으면 교체 확인을 거쳐 replace: true로 시작하고, 그사이 등록됐다는 거절은 알린다", async () => {
    let attempt = 0;
    const { api } = renderAt(PATH, {
      ...settingsRoutes(REGISTERED),
      [`POST ${START}`]: () => {
        attempt += 1;
        return attempt === 1
          ? json(200, STARTED)
          : refusal(409, "GITHUB_APP_CONFLICT", {
              reason_code: "author_app_exists",
            });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "GitHub App 교체" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "GitHub App을 교체할까요?",
    });
    await user.click(within(dialog).getByRole("button", { name: "교체" }));
    const danger = within(screen.getByRole("region", { name: "위험 구역" }));
    await user.click(
      await danger.findByRole("button", { name: "새 App 만들기" }),
    );
    await user.type(await screen.findByLabelText("조직 이름"), "acme");
    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(
      api.calls.filter((call) => call.method === "POST").at(-1)?.body,
    ).toMatchObject({ replace: true });

    await user.click(screen.getByRole("button", { name: "GitHub에서 만들기" }));
    expect(
      await screen.findByText(/그사이 다른 사람이 App을 등록했습니다/),
    ).toBeDefined();
    expect(posted).toHaveLength(1);
  });
});

describe("GitHub에서 돌아온 화면", () => {
  const CALLBACK = "/settings/workspace/github/new-app";

  test("code와 state를 한 번 보내고, 주소에서 지운 뒤 설치 화면으로 보낸다", async () => {
    const { api } = renderAt(`${CALLBACK}?code=c0de&state=st4te`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${COMPLETE}`]: () =>
        json(200, {
          github_app: REGISTERED.github_app,
          install_url: "https://github.com/apps/werft-test/installations/new",
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
        }),
    });
    await waitFor(() =>
      expect(assigned).toEqual([
        "https://github.com/apps/werft-test/installations/new",
      ]),
    );
    expect(
      api.calls.filter((call) => call.method === "POST").map((c) => c.body),
    ).toEqual([{ code: "c0de", state: "st4te" }]);
    expect(window.location.search).toBe("");
    expect(
      await screen.findByText("App을 저장했습니다. 설치 화면으로 이동합니다."),
    ).toBeDefined();
  });

  test("키를 저장하지 못했으면 '이미 있는 App 추가' 안내와 GitHub의 App 링크를 보인다", async () => {
    renderAt(`${CALLBACK}?code=c0de&state=st4te`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${COMPLETE}`]: () =>
        refusal(503, "BACKEND_UNAVAILABLE", {
          reason_code: "store_failed",
          app_id: 9,
          html_url: "https://github.com/apps/werft-acme-1a2b",
        }),
    });
    expect(await screen.findByText(/키를 저장하지 못했습니다/)).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: /GitHub에서 App 열기/ })
        .getAttribute("href"),
    ).toBe("https://github.com/apps/werft-acme-1a2b");
    expect(assigned).toEqual([]);
  });

  test("state가 없거나 거절되면 다시 시작하라고 알린다", async () => {
    const { api } = renderAt(CALLBACK, {
      "GET /v1/auth/me": () => json(200, me()),
    });
    expect(
      await screen.findByText(/만료되었거나 이미 쓰였습니다/),
    ).toBeDefined();
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    expect(
      screen.getByRole("link", { name: "GitHub 연결 설정으로" }),
    ).toBeDefined();
  });
});
