import { describe, expect, test } from "bun:test";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness, type Routes } from "../test-support/render-app.tsx";

const { renderAt, screen, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const failing = () => apiError(503, "BACKEND_UNAVAILABLE", "down", true);

/** Fails the first time it is asked, then answers. */
function failOnce(answer: () => Response) {
  let calls = 0;
  const handler = () => (++calls === 1 ? failing() : answer());
  return {
    handler,
    get calls() {
      return calls;
    },
  };
}

describe("데이터 로딩", () => {
  test("목록을 불러오는 동안은 로그인 확인이 아니라 불러오는 중이라고 한다", async () => {
    renderAt("/sessions", {
      ...meOk,
      "GET /v1/sessions": () => new Promise<Response>(() => {}),
    });
    expect(await screen.findByText("불러오는 중입니다")).toBeTruthy();
    expect(screen.queryByText("로그인 상태를 확인하는 중입니다")).toBeNull();
  });
});

describe("없는 주소", () => {
  test("한국어 안내와 홈 링크를 보인다", async () => {
    renderAt("/nope/path", meOk);
    expect(await screen.findByText("찾을 수 없는 화면입니다")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "홈으로" }).getAttribute("href"),
    ).toBe("/");
    expect(screen.queryByText("Not Found")).toBeNull();
  });
});

/*
 * Every read the audit found with a sentence and no way forward: it now
 * fails with a retry button that asks the server again.
 */
const RETRY_CASES: ReadonlyArray<{
  readonly name: string;
  readonly path: string;
  readonly routes: Routes;
  readonly failingKey: string;
  readonly answer: () => Response;
  readonly after: RegExp;
}> = [
  {
    name: "에이전트 목록",
    path: "/agents",
    routes: meOk,
    failingKey: "GET /v1/agents",
    answer: () => json(200, { items: [] }),
    after: /아직 에이전트가 없습니다/,
  },
  {
    name: "에이전트 상세",
    path: `/agents/${AGENT_ID}`,
    routes: { ...agentServer().routes, ...meOk },
    failingKey: `GET /v1/agents/${AGENT_ID}`,
    answer: () => json(200, agentServer().detail()),
    after: /^결제 담당$/,
  },
  {
    name: "구성원 목록",
    path: "/members",
    routes: { ...meOk, "GET /v1/invites": () => json(200, { items: [] }) },
    failingKey: "GET /v1/members",
    answer: () => json(200, { items: [] }),
    after: /아직 구성원이 없습니다/,
  },
  {
    name: "팀 목록",
    path: "/teams",
    routes: meOk,
    failingKey: "GET /v1/teams",
    answer: () => json(200, { items: [] }),
    after: /아직 팀이 없습니다/,
  },
  {
    name: "API key 목록",
    path: "/settings/api-keys",
    routes: meOk,
    failingKey: "GET /v1/api-keys",
    answer: () => json(200, { items: [] }),
    after: /발급된 key가 없습니다/,
  },
  {
    name: "세션 목록",
    path: "/sessions",
    routes: meOk,
    failingKey: "GET /v1/sessions",
    answer: () => json(200, { items: [], next_cursor: null }),
    after: /아직 세션이 없습니다/,
  },
  {
    name: "초대 링크의 로그인 확인",
    path: `/invite/${"t".repeat(43)}`,
    routes: {},
    failingKey: "GET /v1/auth/me",
    answer: () => apiError(401, "UNAUTHORIZED", "Authentication required"),
    after: /^초대를 수락하면 워크스페이스에 들어갑니다/,
  },
  {
    name: "홈의 내가 속한 팀",
    path: "/",
    routes: {
      ...meOk,
      "GET /v1/members": () => json(200, { items: [] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [] }),
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    },
    failingKey: "GET /v1/my-teams",
    answer: () => json(200, { items: [{ id: "t-1", name: "결제팀" }] }),
    after: /^결제팀$/,
  },
];

describe("불러오기 실패", () => {
  for (const item of RETRY_CASES) {
    test(`${item.name}: 다시 시도를 누르면 다시 불러온다`, async () => {
      const source = failOnce(item.answer);
      renderAt(item.path, {
        ...item.routes,
        [item.failingKey]: source.handler,
      });
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("서버가 응답하지 않습니다");
      const user = await setupUser();
      await user.click(
        within(alert).getByRole("button", { name: "다시 시도" }),
      );
      expect(await screen.findByText(item.after)).toBeTruthy();
      expect(source.calls).toBe(2);
    });
  }

  for (const item of [
    { path: "/agents", key: "GET /v1/agents", action: "새 에이전트" },
    { path: "/members", key: "GET /v1/members", action: "초대 링크 만들기" },
    { path: "/teams", key: "GET /v1/teams", action: "팀 만들기" },
  ]) {
    test(`${item.path}: 목록이 실패하면 권한 확인 중 문구도, 만들기 동작도 남기지 않는다`, async () => {
      renderAt(item.path, { ...meOk, [item.key]: failing });
      await screen.findByRole("button", { name: "다시 시도" });
      expect(screen.queryByText("권한을 확인하는 중입니다.")).toBeNull();
      expect(screen.queryByRole("button", { name: item.action })).toBeNull();
    });
  }
});

describe("주소 이름 형식", () => {
  for (const item of [
    { path: "/bootstrap", label: "워크스페이스 식별자 (slug)", routes: {} },
    { path: "/agents/new", label: "식별자 (slug)", routes: meOk },
  ]) {
    test(`${item.path}: 형식이 틀리면 허용 형식을 알려 준다`, async () => {
      renderAt(item.path, item.routes);
      const input = (await screen.findByLabelText(item.label, {
        exact: false,
      })) as HTMLInputElement;
      const user = await setupUser();
      await user.type(input, "Bad Slug");
      expect(input.checkValidity()).toBe(false);
      expect(input.validationMessage).toContain("영어 소문자·숫자·하이픈(-)");
      await user.clear(input);
      await user.type(input, "good-slug");
      expect(input.checkValidity()).toBe(true);
      expect(input.validationMessage).toBe("");
    });
  }
});

describe("화면별 오류 문구", () => {
  test("Google 로그인이 설정되지 않은 설치에서 콜백은 그렇다고 말한다", async () => {
    renderAt("/auth/google/callback?code=c1&state=s1", {
      "POST /v1/auth/google/callback": () =>
        apiError(404, "NOT_FOUND", "Google sign-in is not configured"),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 설치에서는 Google 로그인을 쓸 수 없습니다 — 이메일과 비밀번호로 로그인하세요.",
    );
  });

  test("형식이 틀린 초대 token은 비밀번호를 받지 않고 쓸 수 없는 초대라고 한다", async () => {
    renderAt("/invite/bogus", {
      "GET /v1/auth/me": () =>
        apiError(401, "UNAUTHORIZED", "Authentication required"),
    });
    expect(await screen.findByText("쓸 수 없는 초대입니다")).toBeTruthy();
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
  });

  test("형식이 맞는 token의 400은 입력 문제라 폼을 남긴다", async () => {
    renderAt(`/invite/${"t".repeat(43)}`, {
      "GET /v1/auth/me": () =>
        apiError(401, "UNAUTHORIZED", "Authentication required"),
      "POST /v1/invites/accept": () =>
        apiError(400, "BAD_REQUEST", "Request body is invalid"),
    });
    const user = await setupUser();
    await user.type(
      await screen.findByLabelText("비밀번호"),
      "correct-horse-battery",
    );
    await user.click(screen.getByRole("button", { name: "초대 수락" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("쓸 수 없는 초대입니다")).toBeNull();
    expect(screen.getByLabelText("비밀번호")).toBeTruthy();
  });
});
