import { describe, expect, test } from "bun:test";
import { loginMethodsResponseSchema } from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberPage } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const methods = (...list: string[]) => ({
  "GET /v1/auth/login-methods": () => json(200, { methods: list }),
});
const AUTHORIZE = "https://accounts.google.test/o/oauth2/v2/auth?state=s1";
const signedIn = {
  user_id: me().user?.id,
  workspace_id: me().workspace?.id,
  role: "owner",
  scopes: me().scopes,
  expires_at: "2026-10-12T00:00:00.000Z",
};

describe("로그인 수단 선택", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    for (const list of [["password"], ["password", "google"]])
      expect(
        loginMethodsResponseSchema.safeParse({ methods: list }).success,
      ).toBe(true);
  });

  test("Google이 없으면 비밀번호만 보인다", async () => {
    renderAt("/login", methods("password"));
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Google로 로그인" }),
      ).toBeNull(),
    );
  });

  test("목록을 못 읽어도 비밀번호 로그인은 남는다", async () => {
    renderAt("/login", {
      "GET /v1/auth/login-methods": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "storage down"),
    });
    expect(await screen.findByRole("button", { name: "로그인" })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Google로 로그인" }),
    ).toBeNull();
  });

  test("Google을 고르면 시작 요청 뒤 Google로 가고, 돌아올 곳을 기억한다", async () => {
    sessionStorage.clear();
    const { api, left } = renderAt("/login?redirect=%2Fmembers", {
      ...methods("password", "google"),
      "POST /v1/auth/google/start": () =>
        json(200, { authorization_url: AUTHORIZE }),
    });
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Google로 로그인" }),
    );
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
    // Coming back from Google's page (back button) can start again.
    expect(
      screen
        .getByRole("button", { name: "Google로 로그인" })
        .hasAttribute("disabled"),
    ).toBe(false);
    const start = api.calls.find((c) => c.path === "/v1/auth/google/start");
    expect(start?.headers.get("x-requested-with")).toBe("agent-platform-web");
    expect(sessionStorage.getItem("ap.postLoginPath")).toBe("/members");
  });
});

describe("Google 콜백", () => {
  test("code·state를 한 번 보내고 기억한 곳으로 간다", async () => {
    sessionStorage.setItem("ap.postLoginPath", "/members");
    const { api, history } = renderAt(
      "/auth/google/callback?code=c1&state=s1",
      {
        "POST /v1/auth/google/callback": () => json(200, signedIn),
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/members": () =>
          json(200, memberPage({ items: [], next_cursor: null })),
        "GET /v1/invites": () => json(200, { items: [] }),
      },
    );
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
    const posts = api.calls.filter(
      (c) => c.path === "/v1/auth/google/callback",
    );
    expect(posts.map((c) => c.body)).toEqual([{ code: "c1", state: "s1" }]);
    expect(sessionStorage.getItem("ap.postLoginPath")).toBeNull();
  });

  test("기억한 곳이 다른 origin이면 홈으로 간다", async () => {
    sessionStorage.setItem("ap.postLoginPath", "//evil.example");
    const { history } = renderAt("/auth/google/callback?code=c1&state=s1", {
      "POST /v1/auth/google/callback": () => json(200, signedIn),
      "GET /v1/auth/me": () => json(200, me()),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
  });

  test("거절은 이유별 문구와 로그인 링크다", async () => {
    const cases: [Response, string][] = [
      [
        apiError(401, "UNAUTHORIZED", "Google sign-in was not accepted"),
        "Google 계정으로 로그인하지 못했습니다 — 초대받은 이메일 주소의 계정인지 확인하고 다시 시도하세요.",
      ],
      [
        apiError(
          403,
          "FORBIDDEN",
          "This Google account's domain is not allowed here",
        ),
        "이 Google 계정으로는 로그인할 수 없습니다 — 워크스페이스가 허용한 도메인의 계정을 쓰세요.",
      ],
      [
        apiError(
          409,
          "LOGIN_LINK_REQUIRED",
          "Sign in with your existing account",
        ),
        "이미 이 이메일로 만든 계정이 있습니다 — 비밀번호로 로그인하세요.",
      ],
    ];
    for (const [response, text] of cases) {
      const { container } = renderAt("/auth/google/callback?code=c&state=s", {
        "POST /v1/auth/google/callback": () => response.clone(),
      });
      await waitFor(() =>
        expect(container.querySelector("[role=alert]")?.textContent).toBe(text),
      );
      expect(container.querySelector('a[href="/login"]')?.textContent).toBe(
        "로그인 화면으로",
      );
      container.remove();
    }
  });

  test("code 없이 돌아오면(동의 취소) 보내지 않고 다시 하라고 한다", async () => {
    const { api } = renderAt("/auth/google/callback?error=access_denied", {});
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Google 로그인을 마치지 못했습니다 — 다시 시도하세요.",
    );
    expect(api.calls).toEqual([]);
  });
});

describe("로그인 화면 안내", () => {
  test("로그인에 실패하면 '소유자를 만들었습니다' 알림을 거둔다", async () => {
    renderAt("/login?notice=created", {
      ...methods("password"),
      "POST /v1/auth/login": () =>
        apiError(401, "UNAUTHORIZED", "Invalid credentials"),
    });
    expect(await screen.findByText(/소유자를 만들었습니다/)).toBeDefined();
    const user = await setupUser();
    await user.type(screen.getByLabelText("이메일"), "owner@example.com");
    await user.type(screen.getByLabelText("비밀번호"), "wrong-wrong-wrong");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByText(/소유자를 만들었습니다/)).toBeNull();
  });

  test("이미 로그인했으면 폼 없이 홈으로 바꿔 간다", async () => {
    const { history } = renderAt("/login", {
      ...methods("password"),
      "GET /v1/auth/me": () => json(200, me()),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(history.length).toBe(1);
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
  });

  test("로그인된 화면에서 /login으로 가도 뒤로 가기에 /login이 남지 않는다", async () => {
    const { history } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
    history.push("/login");
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    expect(history.length).toBe(2);
    history.back();
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
  });

  test("이미 로그인했으면 안전한 redirect 경로로 간다", async () => {
    const { history } = renderAt("/login?redirect=%2Fmembers", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [], next_cursor: null })),
      "GET /v1/invites": () => json(200, { items: [] }),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/members"));
    expect(history.length).toBe(1);
  });

  test("다른 origin을 가리키는 redirect는 홈으로 간다", async () => {
    for (const unsafe of [
      "//evil.example",
      "https://evil.example/",
      "/\\evil.example",
    ]) {
      const { history, container } = renderAt(
        `/login?redirect=${encodeURIComponent(unsafe)}`,
        { "GET /v1/auth/me": () => json(200, me()) },
      );
      await waitFor(() => expect(history.location.pathname).toBe("/"));
      expect(history.location.href).toBe("/");
      container.remove();
    }
  });

  test("세션을 확인하는 동안에는 폼을 그리지 않는다", async () => {
    let answer: (response: Response) => void = () => {};
    renderAt("/login", {
      ...methods("password"),
      "GET /v1/auth/me": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    expect(
      await screen.findByText("로그인 상태를 확인하는 중입니다"),
    ).toBeDefined();
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
    answer(apiError(401, "UNAUTHORIZED", "Authentication is required"));
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
  });

  test("로그인하지 않았으면 폼을 그대로 보인다", async () => {
    renderAt("/login", {
      ...methods("password"),
      "GET /v1/auth/me": () =>
        apiError(401, "UNAUTHORIZED", "Authentication is required"),
    });
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    expect(screen.queryByText("로그인이 필요합니다")).toBeNull();
  });
});
