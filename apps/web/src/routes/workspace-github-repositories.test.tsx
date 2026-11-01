import { describe, expect, test } from "bun:test";
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

const PATH = "/settings/workspace/github";
const BASE = `/v1/workspaces/${WORKSPACE_ID}`;
const LIST = `${BASE}/github-repositories`;
const RECEIPT = "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f";

const APP = {
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
  installations: [
    {
      id: 77,
      account: "acme",
      repository_selection: "selected",
      html_url: "https://github.com/settings/installations/77",
    },
  ],
  repositories: [],
};

const row = (fields: Record<string, unknown>) => ({
  github_repository_id: 11,
  full_name: "acme/api",
  url: "https://github.com/acme/api.git",
  branch: "main",
  source: "console",
  editable: true,
  version: 1,
  installed: true,
  updated_at: "2026-11-01T00:00:00.000Z",
  id: "api",
  ...fields,
});
const FILE_ROW = row({
  id: "tool",
  github_repository_id: null,
  full_name: "acme/tool",
  url: "https://github.com/acme/tool.git",
  source: "file",
  editable: false,
  version: null,
  installed: null,
  updated_at: null,
});

function routes(state: { rows: unknown[] }, extra = {}) {
  return {
    "GET /v1/auth/me": () => json(200, me()),
    [`GET ${GITHUB_SETTINGS}`]: () => json(200, githubSettings()),
    [`GET ${BASE}/github-apps/author`]: () => json(200, APP),
    [`GET ${BASE}/github-apps/reviewer`]: () =>
      json(200, { ...APP, github_app: null, check: null, installations: [] }),
    [`GET ${LIST}`]: () => json(200, { repositories: state.rows }),
    ...extra,
  };
}

const card = async () => {
  await screen.findByRole("region", { name: "에이전트가 쓰는 저장소" });
  return within(screen.getByRole("region", { name: "에이전트가 쓰는 저장소" }));
};

describe("GitHub 연결 › 에이전트가 쓰는 저장소", () => {
  test("설치된 저장소에서 골라 추가하면 GitHub id만 보내고 목록을 다시 읽는다", async () => {
    const state = { rows: [FILE_ROW] as unknown[] };
    const { api } = renderAt(
      PATH,
      routes(state, {
        [`GET ${LIST}/candidates`]: () =>
          json(200, {
            candidates: [
              {
                github_repository_id: 11,
                full_name: "acme/api",
                account: "acme",
                default_branch: "main",
                private: true,
                catalog_id: null,
              },
              {
                github_repository_id: 12,
                full_name: "acme/web",
                account: "acme",
                default_branch: "develop",
                private: false,
                catalog_id: "web",
              },
            ],
            unavailable: null,
          }),
        [`POST ${LIST}`]: () => {
          state.rows = [row({}), FILE_ROW];
          return json(201, { repository: row({}), receipt_id: RECEIPT });
        },
      }),
    );
    const user = await setupUser();
    const repos = await card();
    // A file entry is read-only.
    expect(await repos.findByText("설정 파일")).toBeDefined();
    expect(repos.queryByRole("button", { name: "acme/tool 편집" })).toBeNull();

    await user.click(repos.getByRole("button", { name: "저장소 추가" }));
    const picker = within(
      await screen.findByRole("region", { name: "App이 설치된 저장소" }),
    );
    expect(await picker.findByText("이미 추가됨")).toBeDefined();
    // The search narrows the list by name.
    await user.type(picker.getByRole("searchbox"), "WEB");
    expect(picker.queryByRole("button", { name: "acme/api 추가" })).toBeNull();
    await user.clear(picker.getByRole("searchbox"));
    await user.type(picker.getByRole("searchbox"), "nothing");
    expect(picker.getByText("맞는 저장소가 없습니다.")).toBeDefined();
    await user.clear(picker.getByRole("searchbox"));
    await user.click(picker.getByRole("button", { name: "acme/api 추가" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "acme/api을(를) 추가했습니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "POST").map((c) => c.body),
    ).toEqual([{ github_repository_id: 11 }]);
    expect(
      await repos.findByRole("button", { name: "acme/api 편집" }),
    ).toBeDefined();
  });

  test("기본 브랜치를 바꾸면 읽은 version과 함께 보내고, 쓰는 곳이 있으면 제거를 거절한 이유를 보인다", async () => {
    const state = { rows: [row({})] as unknown[] };
    const { api } = renderAt(
      PATH,
      routes(state, {
        [`PATCH ${LIST}/api`]: () => {
          state.rows = [row({ branch: "develop", version: 2 })];
          return json(200, {
            repository: row({ branch: "develop", version: 2 }),
            receipt_id: RECEIPT,
          });
        },
        [`DELETE ${LIST}/api`]: () =>
          json(409, {
            error: {
              code: "REPOSITORY_IN_USE",
              message: "in use",
              retryable: false,
              request_id: "req-1",
              details: { installation_profiles: ["coding"], agents: [] },
            },
          }),
      }),
    );
    const user = await setupUser();
    const repos = await card();
    await user.click(
      await repos.findByRole("button", { name: "acme/api 편집" }),
    );
    const branch = screen.getByLabelText("기본 브랜치");
    expect(document.activeElement === branch).toBe(true);
    await user.clear(branch);
    await user.type(branch, "develop");
    await user.click(repos.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "acme/api의 기본 브랜치를 develop(으)로 바꿨습니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
    ).toEqual([{ branch: "develop", version: 1 }]);

    await user.click(
      await repos.findByRole("button", { name: "acme/api 편집" }),
    );
    await user.click(screen.getByRole("button", { name: "acme/api 제거" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "제거" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "실행 프로필 상한: coding. 에이전트: 없음.",
      ),
    );
  });
});
