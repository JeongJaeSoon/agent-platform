import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemberView } from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import { apiError, json, me, USER_ID } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const TOKEN = "k".repeat(43);
const owner: MemberView = {
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
  disabled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
};
const created = () =>
  json(201, {
    invite_id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
    invite_token: TOKEN,
    expires_at: "2026-10-18T00:00:00.000Z",
  });

function renderMembers(invite: () => Response = created) {
  return renderAt("/members", {
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/members": () => json(200, { items: [owner] }),
    "GET /v1/invites": () => json(200, { items: [] }),
    "POST /v1/invites": invite,
  });
}

async function open() {
  const user = await setupUser();
  await user.click(
    await screen.findByRole("button", { name: "초대 링크 만들기" }),
  );
  const dialog = await screen.findByRole("dialog");
  return { user, dialog };
}

const currentStep = (dialog: HTMLElement) =>
  dialog.querySelector('[aria-current="step"]')?.textContent;

const invitePosts = (api: {
  calls: readonly { path: string; method: string; body?: unknown }[];
}) => api.calls.filter((c) => c.path === "/v1/invites" && c.method === "POST");

describe("초대 보내기 대화상자", () => {
  test("받는 사람 단계에서 링크 단계로 넘어가고, 마지막 단계에 링크와 만료 시각이 보인다", async () => {
    const { api, history } = renderMembers();
    const { user, dialog } = await open();
    expect(currentStep(dialog)).toContain("받는 사람");
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.selectOptions(within(dialog).getByLabelText("역할"), "admin");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    const link = (await within(dialog).findByLabelText(
      "초대 링크",
    )) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/invite/${TOKEN}`);
    expect(currentStep(dialog)).toContain("초대 링크");
    expect(dialog.textContent).toContain("한 번만 보입니다");
    expect(history.location.search).toContain("invite.step=link");
    expect(invitePosts(api)[0]?.body).toEqual({
      email: "new@example.com",
      role: "admin",
    });
  });

  test("링크의 token은 단계 기록(history.state)에 남지 않는다", async () => {
    const { history } = renderMembers();
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    expect(JSON.stringify(history.location.state)).toContain("expires");
    expect(JSON.stringify(history.location.state)).not.toContain(TOKEN);
  });

  test("닫았다 다시 열면 첫 단계의 빈 칸에서 시작한다", async () => {
    renderMembers();
    const first = await open();
    await first.user.type(
      within(first.dialog).getByLabelText("이메일"),
      "new@example.com",
    );
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(first.dialog).findByLabelText("초대 링크");
    await first.user.click(
      within(first.dialog).getByRole("button", { name: "닫기" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const again = await open();
    const email = within(again.dialog).getByLabelText(
      "이메일",
    ) as HTMLInputElement;
    expect(email.value).toBe("");
    expect(within(again.dialog).queryByLabelText("초대 링크")).toBeNull();
    expect(currentStep(again.dialog)).toContain("받는 사람");
  });

  test("다른 사람 초대는 첫 단계로 돌아가 앞 링크를 지운다", async () => {
    renderMembers();
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "a@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    await user.click(
      within(dialog).getByRole("button", { name: "다른 사람 초대" }),
    );
    const email = (await within(dialog).findByLabelText(
      "이메일",
    )) as HTMLInputElement;
    expect(email.value).toBe("");
    expect(within(dialog).queryByLabelText("초대 링크")).toBeNull();
  });
});

describe("입력 검증(W24 규약)", () => {
  test("빈 이메일과 이메일 아닌 값은 서버에 묻지 않고 칸에 이유를 붙인다", async () => {
    const { api } = renderMembers();
    const { user, dialog } = await open();
    const email = within(dialog).getByLabelText("이메일");
    const submit = within(dialog).getByRole("button", {
      name: "초대 링크 만들기",
    });
    const reason = () =>
      (email.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");

    // The contract's email check has no minimum, so blank reads as a format.
    for (const value of ["   ", "not-an-email"]) {
      await user.clear(email);
      await user.type(email, value);
      await user.click(submit);
      await waitFor(() =>
        expect(reason()).toContain("이메일 주소 형식이 아닙니다."),
      );
      expect(email.getAttribute("aria-invalid")).toBe("true");
    }
    expect(invitePosts(api)).toHaveLength(0);
  });

  test("앞뒤 공백은 지우고 보낸다", async () => {
    const { api } = renderMembers();
    const { user, dialog } = await open();
    await user.type(
      within(dialog).getByLabelText("이메일"),
      "  new@example.com  ",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    expect(invitePosts(api)[0]?.body).toEqual({
      email: "new@example.com",
      role: "member",
    });
  });

  test("서버 400은 서버 문구 대신 폼 위 한 줄로 보이고 첫 단계에 남는다", async () => {
    renderMembers(() =>
      apiError(400, "BAD_REQUEST", "body.email: Invalid email address"),
    );
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    const alerts = await within(dialog).findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).not.toContain("body.email");
    expect(within(dialog).getByLabelText("이메일")).toBeDefined();
  });

  test("서버가 거절한 초대(403)는 비활성 버튼과 같은 문구로 보인다", async () => {
    renderMembers(() =>
      apiError(403, "FORBIDDEN", "This principal does not hold member.manage"),
    );
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });
});

describe("invite token", () => {
  const logged: string[] = [];
  const originals = { ...console };
  beforeEach(() => {
    logged.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      console[level] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
  });
  afterEach(() => {
    Object.assign(console, originals);
  });

  test("링크 칸 밖의 화면 문구와 로그에 나오지 않는다", async () => {
    renderMembers();
    const { user, dialog } = await open();
    await user.type(within(dialog).getByLabelText("이메일"), "new@example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "초대 링크 만들기" }),
    );
    await within(dialog).findByLabelText("초대 링크");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });
});
