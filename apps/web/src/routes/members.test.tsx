import { describe, expect, test } from "bun:test";
import {
  type MemberView,
  memberViewSchema,
  WORKSPACE_ROLE_VALUES,
} from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const OTHER_ID = "2c7e1d4a-5b6f-4a8e-9d0c-1e2f3a4b5c6d";
const GONE_ID = "3d8f2e5b-6c7a-4b9f-8e1d-2f3a4b5c6d7e";

function member(overrides: Partial<MemberView>): MemberView {
  return {
    user_id: USER_ID,
    email: "owner@example.com",
    display_name: "Owner",
    role: "owner",
    disabled_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const owner = member({});
const teammate = member({
  user_id: OTHER_ID,
  email: "mate@example.com",
  display_name: "Mate",
  role: "member",
});
const gone = member({
  user_id: GONE_ID,
  email: "gone@example.com",
  display_name: "Gone",
  role: "member",
  disabled_at: "2026-10-05T00:00:00.000Z",
});

const noInvites = { "GET /v1/invites": () => json(200, { items: [] }) };

type User = Awaited<ReturnType<typeof setupUser>>;

/** Picks a role and goes through with it in the confirmation. */
async function changeRole(user: User, label: string, role: string) {
  await user.selectOptions(await screen.findByLabelText(label), role);
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "역할 바꾸기" }));
}

const pendingInvite = {
  id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
  workspace_id: WORKSPACE_ID,
  email: "late@example.com",
  role: "member",
  invited_by: USER_ID,
  status: "pending",
  expires_at: "2026-10-18T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
  created_at: "2026-10-11T00:00:00.000Z",
};

describe("구성원 화면", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    for (const view of [owner, teammate, gone])
      expect(memberViewSchema.safeParse(view).success).toBe(true);
  });

  test("목록과 상태를 보이고, 역할 선택지는 contracts의 역할 그대로다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, teammate, gone] }),
      ...noInvites,
    });
    const select = await screen.findByLabelText("Mate의 역할");
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("value"))).toEqual([
      ...WORKSPACE_ROLE_VALUES,
    ]);
    // A keyboard reaches the sideways scroll of a table wider than the screen.
    const region = screen.getByRole("region", { name: "구성원 표" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.contains(select)).toBe(true);
    const goneRow = screen.getByText("Gone").closest("tr");
    expect(goneRow?.getAttribute("data-disabled")).toBe("true");
    expect(within(goneRow as HTMLElement).getByText("비활성")).toBeDefined();
    expect(
      within(goneRow as HTMLElement).getByRole("button", {
        name: "다시 활성화",
      }),
    ).toBeDefined();
  });

  test("역할 변경은 서버가 답한 뒤에야 바뀐 것으로 보인다", async () => {
    let current = teammate;
    let release: () => void = () => {};
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, current] }),
      ...noInvites,
      "PATCH /v1/members/2c7e1d4a-5b6f-4a8e-9d0c-1e2f3a4b5c6d": () =>
        new Promise((resolve) => {
          release = () => {
            current = { ...teammate, role: "owner" };
            resolve(json(200, current));
          };
        }),
    });
    const user = await setupUser();
    const select = (await screen.findByLabelText(
      "Mate의 역할",
    )) as HTMLSelectElement;
    await changeRole(user, "Mate의 역할", "owner");
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(select.value).toBe("member");
    expect(screen.queryByText(/역할을 소유자\(으\)로 바꿨습니다/)).toBeNull();
    release();
    expect(
      await screen.findByText("Mate의 역할을 소유자(으)로 바꿨습니다."),
    ).toBeDefined();
    await waitFor(() => expect(select.value).toBe("owner"));
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ role: "owner" });
    expect(patch?.headers.get("x-requested-with")).toBe("agent-platform-web");
  });

  test("마지막 소유자(409 LAST_OWNER)는 그 이유를 보인다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, teammate] }),
      ...noInvites,
      [`PATCH /v1/members/${USER_ID}`]: () =>
        apiError(409, "LAST_OWNER", "The last owner cannot be demoted"),
    });
    const user = await setupUser();
    await changeRole(user, "Owner의 역할", "member");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "마지막 소유자는 역할을 바꾸거나 비활성화할 수 없습니다",
    );
  });

  test("관리자가 소유자 역할을 주려 하면(403 OWNER_PROTECTED) 그 이유를 보인다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () => json(200, { items: [owner, teammate] }),
      ...noInvites,
      [`PATCH /v1/members/${teammate.user_id}`]: () =>
        apiError(403, "OWNER_PROTECTED", "Only an owner can grant owner"),
    });
    const user = await setupUser();
    await changeRole(user, "Mate의 역할", "owner");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "소유자 역할은 소유자만 주거나 바꿀 수 있습니다",
    );
  });

  test("비활성은 결과를 확인받고, 서버가 답하면 재활성 버튼으로 바뀐다", async () => {
    let current = teammate;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, current] }),
      ...noInvites,
      [`POST /v1/members/${OTHER_ID}/disable`]: () => {
        current = { ...teammate, disabled_at: "2026-10-11T00:00:00.000Z" };
        return json(200, { member: current, receipt_id: null });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "Mate 비활성화" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "웹 로그인과 개인 API key가 바로 끊기고",
    );
    await user.click(within(dialog).getByRole("button", { name: "비활성화" }));
    expect(
      await screen.findByText("Mate을(를) 비활성화했습니다."),
    ).toBeDefined();
    const row = (await screen.findByText("Mate")).closest("tr") as HTMLElement;
    await waitFor(() =>
      expect(
        within(row).getByRole("button", { name: "다시 활성화" }),
      ).toBeDefined(),
    );
    expect(api.calls.find((c) => c.path.endsWith("/disable"))?.body).toEqual(
      {},
    );
  });

  test("재활성", async () => {
    let current = gone;
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, current] }),
      ...noInvites,
      [`POST /v1/members/${GONE_ID}/enable`]: () => {
        current = { ...gone, disabled_at: null };
        return json(200, { member: current, receipt_id: "r-1" });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "다시 활성화" }),
    );
    expect(
      await screen.findByText(
        "Gone을(를) 다시 활성화했습니다. 이제 다시 로그인할 수 있습니다.",
      ),
    ).toBeDefined();
  });

  test("초대 링크는 한 번 보이고, 비활성 구성원의 주소면 재활성을 안내한다", async () => {
    const token = "k".repeat(43);
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, gone] }),
      ...noInvites,
      "POST /v1/invites": () =>
        json(201, {
          invite_id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
          invite_token: token,
          expires_at: "2026-10-18T00:00:00.000Z",
        }),
    });
    const user = await setupUser();
    const email = await screen.findByLabelText("이메일");
    await user.type(email, "GONE@example.com");
    const hint = document.getElementById(
      email.getAttribute("aria-describedby") ?? "",
    );
    expect(hint?.textContent).toContain(
      "다시 초대하지 말고 목록에서 다시 활성화하세요",
    );
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: "초대 링크 만들기" }));
    const link = (await screen.findByLabelText(
      "초대 링크",
    )) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/invite/${token}`);
    expect(
      api.calls.find((c) => c.path === "/v1/invites" && c.method === "POST")
        ?.body,
    ).toEqual({
      email: "new@example.com",
      role: "member",
    });
  });

  test("대기 중인 초대를 확인받고 회수한다", async () => {
    const invite = pendingInvite;
    let revoked = false;
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: revoked ? [] : [invite] }),
      [`DELETE /v1/invites/${invite.id}`]: () => {
        revoked = true;
        return new Response(null, { status: 204 });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "late@example.com 초대 회수" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("보낸 링크로는 더 가입할 수 없습니다");
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "회수" }));
    expect(
      await screen.findByText("late@example.com 초대를 회수했습니다."),
    ).toBeDefined();
    expect(await screen.findByText("대기 중인 초대가 없습니다.")).toBeDefined();
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  test("초대 회수를 취소하면 아무것도 보내지 않는다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: [pendingInvite] }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "late@example.com 초대 회수" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("late@example.com")).toBeDefined();
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  for (const [why, clipboard] of [
    [
      "클립보드가 거부하면",
      {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    ],
    ["클립보드가 없으면(비보안 컨텍스트)", undefined],
  ] as const) {
    test(`${why} 직접 복사하라고 알리고 링크 칸을 선택해 둔다`, async () => {
      renderAt("/members", {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/members": () => json(200, { items: [owner] }),
        ...noInvites,
        "POST /v1/invites": () =>
          json(201, {
            invite_id: pendingInvite.id,
            invite_token: "k".repeat(43),
            expires_at: "2026-10-18T00:00:00.000Z",
          }),
      });
      const user = await setupUser();
      await user.type(await screen.findByLabelText("이메일"), "n@example.com");
      await user.click(
        screen.getByRole("button", { name: "초대 링크 만들기" }),
      );
      const copyButton = await screen.findByRole("button", {
        name: "링크 복사",
      });
      const field = screen.getByLabelText<HTMLInputElement>("초대 링크");
      const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: clipboard,
      });
      try {
        // The refusal settles after the click returns; act flushes it.
        await act(async () => copyButton.click());
        expect((await screen.findByRole("alert")).textContent).toBe(
          "초대 링크를 복사하지 못했습니다 — 링크 칸을 눌러 직접 복사하세요.",
        );
        expect(document.activeElement).toBe(field);
        expect(
          field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0),
        ).toBe(field.value);
      } finally {
        if (original) Object.defineProperty(navigator, "clipboard", original);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    });
  }
});

describe("되돌리기 어려운 동작의 확인", () => {
  const routes = (calls: string[]) => ({
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/members": () => json(200, { items: [owner, teammate] }),
    ...noInvites,
    [`PATCH /v1/members/${OTHER_ID}`]: () => {
      calls.push("PATCH");
      return json(200, { ...teammate, role: "owner" });
    },
  });

  test("역할을 골라 넘기기만 해서는 아무것도 보내지 않는다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const { fireEvent } = await import("@testing-library/react");
    const select = (await screen.findByLabelText(
      "Mate의 역할",
    )) as HTMLSelectElement;
    // What arrow keys on a closed select do: a change per step.
    fireEvent.change(select, { target: { value: "admin" } });
    fireEvent.change(select, { target: { value: "owner" } });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "Mate의 역할을 소유자(으)로 바꿀까요?",
    );
    expect(dialog.textContent).toContain("소유자는 워크스페이스 설정과");
    await Bun.sleep(20);
    expect(calls).toEqual([]);
  });

  test("역할 변경을 취소하면 원래 역할 그대로다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const select = (await screen.findByLabelText(
      "Mate의 역할",
    )) as HTMLSelectElement;
    await user.selectOptions(select, "admin");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(select.value).toBe("member");
    expect(calls).toEqual([]);
  });

  test("자기 자신과 하나뿐인 소유자는 비활성화를 막고 이유를 붙인다", async () => {
    const other = member({
      user_id: GONE_ID,
      email: "boss@example.com",
      display_name: "Boss",
      role: "owner",
    });
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(200, {
          items: [{ ...owner, role: "admin" }, other, teammate],
        }),
      ...noInvites,
    });
    const reasonOf = async (name: string) => {
      const button = (await screen.findByRole("button", {
        name: `${name} 비활성화`,
      })) as HTMLButtonElement;
      const reason = document.getElementById(
        button.getAttribute("aria-describedby") ?? "",
      );
      return { disabled: button.disabled, reason: reason?.textContent };
    };
    expect(await reasonOf("Owner")).toEqual({
      disabled: true,
      reason: "자기 자신은 비활성화할 수 없습니다.",
    });
    expect(await reasonOf("Boss")).toEqual({
      disabled: true,
      reason:
        "하나뿐인 소유자는 비활성화할 수 없습니다 — 다른 사람을 먼저 소유자로 정하세요.",
    });
    expect((await reasonOf("Mate")).disabled).toBe(false);
  });
});

describe("권한", () => {
  const forbidden = () =>
    apiError(403, "FORBIDDEN", "This principal does not hold member.manage");

  test("관리 권한이 없으면 초대 버튼을 숨기지 않고 끈 채 이유를 적는다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("이 화면을 볼 권한이 없습니다");
    expect(alert.textContent).toContain("does not hold member.manage");
    const button = screen.getByRole("button", { name: "초대 링크 만들기" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe(
      "member.manage 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.",
    );
    expect(api.calls.some((c) => c.path === "/v1/invites")).toBe(false);
  });

  test("서버가 거절한 동작(403)은 비활성 버튼과 같은 문구로 보인다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, teammate] }),
      ...noInvites,
      [`PATCH /v1/members/${OTHER_ID}`]: forbidden,
    });
    const user = await setupUser();
    await changeRole(user, "Mate의 역할", "owner");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "member.manage 권한이 있어야 할 수 있습니다. 지금 역할: 소유자. This principal does not hold member.manage",
    );
  });

  test("이 빌드가 모르는 역할이어도 서버가 목록을 주면 관리할 수 있다", async () => {
    const future = { ...me(), principal: { ...me().principal, role: "admin" } };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, future),
      "GET /v1/members": () => json(200, { items: [owner, teammate] }),
      ...noInvites,
    });
    const button = await screen.findByRole("button", {
      name: "초대 링크 만들기",
    });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
