import { describe, expect, test } from "bun:test";
import {
  LINK_MESSAGES,
  type LinkedAccount,
  linkedAccountSchema,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  RECEIPT_ID,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const LINK_ID = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const AUTHORIZE = "http://mock-slack.test/openid/connect/authorize?state=s1";
const slack: LinkedAccount = {
  id: LINK_ID,
  user_id: USER_ID,
  provider: "slack",
  external_tenant: "T0MOCK",
  external_user_id: "U0MOCK",
  status: "active",
  verified_at: "2026-10-11T00:00:00.000Z",
  revision: 1,
};
const meOk = { "GET /v1/auth/me": () => json(200, me()) };

describe("연동 계정", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(linkedAccountSchema.safeParse(slack).success).toBe(true);
  });

  test("연결이 없으면 연결 버튼이 Slack 동의 화면으로 보낸다", async () => {
    const { api, left } = renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/slack/start": () =>
        json(200, {
          authorize_url: AUTHORIZE,
          expires_at: "2026-10-11T00:10:00.000Z",
        }),
    });
    expect(
      await screen.findByText("연결된 Slack 계정이 없습니다."),
    ).toBeDefined();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "Slack 계정 연결" }));
    await waitFor(() => expect(left).toEqual([AUTHORIZE]));
    expect(
      api.calls.some((c) => c.path === "/v1/linked-accounts/slack/start"),
    ).toBe(true);
  });

  test("설치가 없다는 거절은 서버의 안내 문구 그대로다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/slack/start": () =>
        apiError(409, "SLACK_NOT_INSTALLED", LINK_MESSAGES.notInstalled),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Slack 계정 연결" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      LINK_MESSAGES.notInstalled,
    );
  });

  test("연결된 계정을 보이고 해제한다", async () => {
    let items = [slack];
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items }),
      [`DELETE /v1/linked-accounts/${LINK_ID}`]: () => {
        items = [{ ...slack, status: "revoked" }];
        return json(200, {
          receipt_id: RECEIPT_ID,
          receipt_status: "succeeded",
        });
      },
    });
    expect(
      await screen.findByText("Slack 사용자 U0MOCK (워크스페이스 T0MOCK)"),
    ).toBeDefined();
    // Another Slack workspace can be linked alongside this one.
    expect(
      screen.getByRole("button", { name: "Slack 계정 연결" }),
    ).toBeDefined();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "연결 해제" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Slack 계정 연결을 해제했습니다.",
    );
    expect(
      await screen.findByText("연결된 Slack 계정이 없습니다."),
    ).toBeDefined();
  });

  test("Slack이 돌려보내면 code·state를 한 번 보내고 목록으로 간다", async () => {
    let items: LinkedAccount[] = [];
    const { api, history } = renderAt(
      "/settings/linked-accounts/slack?code=c1&state=s1",
      {
        ...meOk,
        "POST /v1/linked-accounts/slack/callback": () => {
          items = [slack];
          return json(201, { linked_account: slack, receipt_id: RECEIPT_ID });
        },
        "GET /v1/linked-accounts": () => json(200, { items }),
      },
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe("/settings/linked-accounts"),
    );
    expect(
      await screen.findByText("Slack 사용자 U0MOCK (워크스페이스 T0MOCK)"),
    ).toBeDefined();
    expect(
      api.calls
        .filter((c) => c.path === "/v1/linked-accounts/slack/callback")
        .map((c) => c.body),
    ).toEqual([{ code: "c1", state: "s1" }]);
  });

  test("다른 사람에게 연결된 계정이면 서버 문구와 돌아갈 링크다", async () => {
    renderAt("/settings/linked-accounts/slack?code=c1&state=s1", {
      ...meOk,
      "POST /v1/linked-accounts/slack/callback": () =>
        apiError(409, "LINK_TAKEN", LINK_MESSAGES.taken),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      LINK_MESSAGES.taken,
    );
    expect(
      screen.getByRole("link", { name: "연동 계정으로" }).getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test("설정이 없는 설치에서 연결을 시작하면 운영자 문의를 안내한다", async () => {
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
      "POST /v1/linked-accounts/slack/start": () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "Sign in with Slack is not configured on this installation",
        ),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Slack 계정 연결" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 설치에서는 Slack 계정 연결을 쓸 수 없습니다 — 운영자에게 문의하세요.",
    );
  });

  test("콜백 중 Slack에 닿지 못하면 다시 시도하라고 한다", async () => {
    renderAt("/settings/linked-accounts/slack?code=c1&state=s1", {
      ...meOk,
      "POST /v1/linked-accounts/slack/callback": () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "Slack could not be reached, try again later",
          true,
        ),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
    );
  });

  test("이 설치에 Slack 연결이 설정되지 않았으면 콜백도 쓸 수 없다고 한다", async () => {
    renderAt("/settings/linked-accounts/slack?code=c1&state=s1", {
      ...meOk,
      "POST /v1/linked-accounts/slack/callback": () =>
        apiError(
          503,
          "BACKEND_UNAVAILABLE",
          "Sign in with Slack is not configured on this installation",
        ),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "이 설치에서는 Slack 계정 연결을 쓸 수 없습니다 — 운영자에게 문의하세요.",
    );
  });

  test("목록을 불러오지 못하면 다시 시도로 다시 묻는다", async () => {
    let calls = 0;
    renderAt("/settings/linked-accounts", {
      ...meOk,
      "GET /v1/linked-accounts": () =>
        ++calls === 1
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: [] }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(
      await screen.findByText("연결된 Slack 계정이 없습니다."),
    ).toBeTruthy();
    expect(calls).toBe(2);
  });

  test("로그인이 끊겼으면 로그인 뒤 같은 콜백으로 돌아오게 한다", async () => {
    const { history } = renderAt(
      "/settings/linked-accounts/slack?code=c1&state=s1",
      {
        "GET /v1/auth/me": () =>
          apiError(401, "UNAUTHORIZED", "Authentication required"),
      },
    );
    await waitFor(() => expect(history.location.pathname).toBe("/login"));
    expect(history.location.search).toContain(
      encodeURIComponent("/settings/linked-accounts/slack?code=c1&state=s1"),
    );
  });
});
