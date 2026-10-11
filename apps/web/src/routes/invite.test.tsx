import { describe, expect, test } from "bun:test";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen } = await appHarness();

const TOKEN = "t".repeat(43);
const signedOut = () =>
  apiError(401, "UNAUTHORIZED", "Authentication is required");

async function accept(password = "correct horse battery", name = "") {
  const user = await setupUser();
  await user.type(await screen.findByLabelText("비밀번호"), password);
  if (name) await user.type(screen.getByLabelText("이름"), name);
  await user.click(screen.getByRole("button", { name: "초대 수락" }));
}

describe("초대 수락", () => {
  test("로그인 전에는 비밀번호로 수락하고, 수락하면 워크스페이스로 들어간다", async () => {
    let accepted = false;
    const { api, history } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": () => (accepted ? json(200, me()) : signedOut()),
      "POST /v1/invites/accept": () => {
        accepted = true;
        return json(200, {
          user_id: me().user?.id,
          workspace: me().workspace,
          role: "member",
        });
      },
    });
    await accept("correct horse battery", "Newcomer");
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeDefined();
    expect(history.location.pathname).toBe("/");
    const call = api.calls.find((c) => c.path === "/v1/invites/accept");
    expect(call?.body).toEqual({
      token: TOKEN,
      password: "correct horse battery",
      display_name: "Newcomer",
    });
    expect(call?.headers.get("x-requested-with")).toBe("agent-platform-web");
  });

  test("이름을 비우면 보내지 않는다(기존 계정은 이름이 필요 없다)", async () => {
    const { api } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () => apiError(410, "INVITE_EXPIRED", "gone"),
    });
    await accept();
    await screen.findByText("쓸 수 없는 초대입니다");
    const call = api.calls.find((c) => c.path === "/v1/invites/accept");
    expect(call?.body).toEqual({
      token: TOKEN,
      password: "correct horse battery",
    });
  });

  test("만료·회수된 초대(410)는 폼 대신 새 링크를 요청하라고 한다", async () => {
    renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(410, "INVITE_EXPIRED", "This invite was revoked"),
    });
    await accept();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("만료됐거나 회수된 초대입니다");
    expect(screen.queryByRole("button", { name: "초대 수락" })).toBeNull();
  });

  test("이미 쓴 초대(409)는 로그인으로 안내한다", async () => {
    renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(409, "INVITE_USED", "This invite was already used"),
    });
    await accept();
    expect(await screen.findByText("이미 수락한 초대입니다")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "로그인 화면으로" })
        .getAttribute("href"),
    ).toBe("/login");
  });

  test("틀린 비밀번호(401)는 폼에 남고 로그인 화면으로 튕기지 않는다", async () => {
    const { history } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": signedOut,
      "POST /v1/invites/accept": () =>
        apiError(401, "UNAUTHORIZED", "Invite token or password is invalid"),
    });
    await accept("wrong password!!");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Google로만 로그인해 온 계정은",
    );
    expect(history.location.pathname).toBe(`/invite/${TOKEN}`);
    expect(screen.getByRole("button", { name: "초대 수락" })).toBeDefined();
  });

  test("이미 로그인한 구성원에게는 수락할 필요가 없다고 하고, 로그아웃하면 폼을 보인다", async () => {
    let signedIn = true;
    const { api } = renderAt(`/invite/${TOKEN}`, {
      "GET /v1/auth/me": () => (signedIn ? json(200, me()) : signedOut()),
      "POST /v1/auth/logout": () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    expect(
      await screen.findByText("이미 이 워크스페이스의 구성원입니다"),
    ).toBeDefined();
    expect(screen.getByText(/owner@example.com 계정으로 Acme에/)).toBeDefined();
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
    const user = await setupUser();
    await user.click(
      screen.getByRole("button", { name: "로그아웃하고 다른 계정으로 수락" }),
    );
    expect(await screen.findByLabelText("비밀번호")).toBeDefined();
    expect(api.calls.some((c) => c.path === "/v1/invites/accept")).toBe(false);
  });

  test("네 경우의 문구가 서로 다르다", async () => {
    const { ko } = await import("../i18n/ko.ts");
    const titles = [
      ko["invite.intro"],
      ko["invite.member.title"],
      ko["invite.expired.title"],
      ko["invite.used.title"],
    ];
    expect(new Set(titles).size).toBe(4);
  });
});
