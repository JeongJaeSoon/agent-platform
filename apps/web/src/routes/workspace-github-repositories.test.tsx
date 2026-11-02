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
  source: "selection",
  editable: true,
  version: 1,
  installed: true,
  updated_at: "2026-11-01T00:00:00.000Z",
  id: "api",
  agent_count: 0,
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

const installed = (n: number) => ({
  github_repository_id: 100 + n,
  full_name: `acme/repo-${String(n).padStart(3, "0")}`,
  default_branch: "main",
  private: n % 2 === 0,
  catalog_id: n === 1 ? "api" : null,
  agent_count: n === 1 ? 3 : 0,
});

const installation = (
  id: number,
  account: string,
  role: "author" | "reviewer",
) => ({
  id,
  account,
  connection_id: `app-${role}`,
  role,
  permissions: { contents: "write" },
  repository_count: 65,
});

/** 65 repositories, 30 a page, as GitHub pages them. */
function page(search: string, catalog: unknown[]) {
  const query = new URLSearchParams(search);
  const at = Number(query.get("page") ?? "1");
  const perPage = Number(query.get("per_page") ?? "30");
  const all = Array.from({ length: 65 }, (_, i) => installed(i + 1));
  return {
    installations: [
      installation(77, "acme", "author"),
      installation(78, "other", "reviewer"),
    ],
    installation_id: Number(query.get("installation_id") ?? "77"),
    page: at,
    per_page: perPage,
    total_count: all.length,
    repositories: all.slice((at - 1) * perPage, at * perPage),
    unavailable: null,
    catalog,
  };
}

function routes(state: { rows: unknown[] }, extra = {}) {
  return {
    "GET /v1/auth/me": () => json(200, me()),
    [`GET ${GITHUB_SETTINGS}`]: () => json(200, githubSettings()),
    [`GET ${BASE}/github-apps/author`]: () => json(200, APP),
    [`GET ${BASE}/github-apps/reviewer`]: () =>
      json(200, { ...APP, github_app: null, check: null, installations: [] }),
    [`GET ${LIST}`]: (request: Request) =>
      json(200, page(new URL(request.url).search, state.rows)),
    ...extra,
  };
}

const card = async () => {
  await screen.findByRole("region", { name: "에이전트가 쓰는 저장소" });
  return within(screen.getByRole("region", { name: "에이전트가 쓰는 저장소" }));
};

describe("GitHub 연결 › 에이전트가 쓰는 저장소", () => {
  test("설치된 저장소를 한 쪽씩 읽고, 설치를 바꾸면 첫 쪽부터 읽는다", async () => {
    const state = { rows: [row({}), FILE_ROW] as unknown[] };
    const { api } = renderAt(PATH, routes(state));
    const user = await setupUser();
    const repos = await card();
    // A file entry is read-only; a picked row is edited here.
    expect(await repos.findByText("설정 파일")).toBeDefined();
    expect(repos.queryByRole("button", { name: "acme/tool 편집" })).toBeNull();
    expect(
      await repos.findByRole("button", { name: "acme/api 편집" }),
    ).toBeDefined();

    await user.click(repos.getByRole("button", { name: "설치된 저장소 보기" }));
    const browse = within(
      await screen.findByRole("region", { name: "App이 설치된 저장소" }),
    );
    expect(browse.getByText("acme/repo-001")).toBeDefined();
    expect(browse.getByText("에이전트 3개가 사용")).toBeDefined();
    expect(browse.getByText("65개 중 1–30")).toBeDefined();
    expect(
      browse.getByRole("button", { name: "이전" }).hasAttribute("disabled"),
    ).toBe(true);

    await user.click(browse.getByRole("button", { name: "다음" }));
    expect(await browse.findByText("acme/repo-031")).toBeDefined();
    await user.click(browse.getByRole("button", { name: "다음" }));
    expect(await browse.findByText("65개 중 61–65")).toBeDefined();
    expect(
      browse.getByRole("button", { name: "다음" }).hasAttribute("disabled"),
    ).toBe(true);

    expect(
      browse.getByRole("option", { name: "other (리뷰용 App)" }),
    ).toBeDefined();
    await user.selectOptions(browse.getByLabelText("설치"), "78");
    expect(await browse.findByText("65개 중 1–30")).toBeDefined();
    const searches = api.calls
      .filter((c) => c.method === "GET" && c.path === LIST)
      .map((c) => new URLSearchParams(c.search));
    expect(
      searches.map((s) => [
        s.get("installation_id"),
        s.get("page"),
        s.get("per_page"),
      ]),
    ).toEqual(
      expect.arrayContaining([
        [null, "1", "30"],
        [null, "2", "30"],
        [null, "3", "30"],
        ["78", "1", "30"],
      ]),
    );
  });

  test.each([
    ["사라지면", 404, "NOT_FOUND", "installation_not_found"],
    ["정지되면", 409, "INSTALLATION_SUSPENDED", "installation_suspended"],
  ])(
    "고른 설치가 GitHub에서 %s 첫 설치로 돌아간다",
    async (_, status, code, reason) => {
      const state = { rows: [row({})] as unknown[] };
      let gone = false;
      const { api } = renderAt(
        PATH,
        routes(state, {
          [`GET ${LIST}`]: (request: Request) => {
            const search = new URL(request.url).search;
            return gone && search.includes("installation_id=78")
              ? json(status, {
                  error: {
                    code,
                    message: "The installation cannot be read",
                    retryable: false,
                    request_id: "req-1",
                    details: { reason_code: reason },
                  },
                })
              : json(200, page(search, state.rows));
          },
        }),
      );
      const user = await setupUser();
      const repos = await card();
      await user.click(
        repos.getByRole("button", { name: "설치된 저장소 보기" }),
      );
      const region = await screen.findByRole("region", {
        name: "App이 설치된 저장소",
      });
      const browse = within(region);
      expect(await browse.findByText("acme/repo-001")).toBeDefined();
      gone = true;
      await user.selectOptions(browse.getByLabelText("설치"), "78");
      await waitFor(() => {
        expect(
          api.calls.some(
            (c) =>
              c.method === "GET" &&
              c.path === LIST &&
              c.search.includes("installation_id=78"),
          ),
        ).toBe(true);
        // Read directly: happy-dom calls the select non-labellable mid re-render.
        expect(region.querySelector("select")?.value).toBe("77");
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.queryByText("불러오지 못했습니다")).toBeNull();
      expect(
        repos.getByRole("button", { name: "acme/api 편집" }),
      ).toBeDefined();
    },
  );

  test("GitHub가 작성용 App에 답하지 않아도 카탈로그 행은 남고, 이유를 보이며 다른 설치를 고를 수 있다", async () => {
    const state = { rows: [row({})] as unknown[] };
    const { api } = renderAt(
      PATH,
      routes(state, {
        [`GET ${LIST}`]: (request: Request) => {
          const search = new URL(request.url).search;
          return search.includes("installation_id=78")
            ? json(200, page(search, state.rows))
            : json(200, {
                ...page(search, state.rows),
                installations: [installation(78, "other", "reviewer")],
                installation_id: null,
                total_count: 0,
                repositories: [],
                unavailable: "github_unavailable",
              });
        },
      }),
    );
    const user = await setupUser();
    const repos = await card();
    expect(
      await repos.findByRole("button", { name: "acme/api 편집" }),
    ).toBeDefined();
    await user.click(repos.getByRole("button", { name: "설치된 저장소 보기" }));
    const browse = within(
      await screen.findByRole("region", { name: "App이 설치된 저장소" }),
    );
    expect(
      browse.getByText(/^GitHub에서 App의 설치나 저장소를 받지 못했습니다/),
    ).toBeDefined();
    await user.selectOptions(browse.getByLabelText("설치"), "78");
    expect(await browse.findByText("acme/repo-001")).toBeDefined();
    expect(api.calls.some((c) => c.search.includes("installation_id=78"))).toBe(
      true,
    );
  });

  test("기본 브랜치를 바꾸면 읽은 version과 함께 보낸다", async () => {
    const state = { rows: [row({})] as unknown[] };
    const { api } = renderAt(
      PATH,
      routes(state, {
        [`PATCH ${LIST}/api`]: () => {
          state.rows = [row({ branch: "develop", version: 2 })];
          const { agent_count: _, ...repository } = row({
            branch: "develop",
            version: 2,
          });
          return json(200, {
            repository,
            receipt_id: RECEIPT,
          });
        },
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
    // A row agents' releases may name is never removed.
    expect(repos.queryByRole("button", { name: "acme/api 제거" })).toBeNull();
  });
});
