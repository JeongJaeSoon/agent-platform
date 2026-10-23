import { describe, expect, test } from "bun:test";
import {
  type MemberView,
  memberViewSchema,
  WORKSPACE_ROLE_VALUES,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
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

const ROLE_NAME = { owner: "소유자", admin: "관리자", member: "구성원" };

/** Opens 구성원 편집 for a member and returns the dialog. */
async function openEdit(user: User, name: string) {
  await user.click(await screen.findByRole("button", { name: `${name} 편집` }));
  return screen.findByRole("dialog", { name: "구성원 편집" });
}

/** Picks a role in 구성원 편집 and saves it, which asks to confirm. */
async function pickRole(
  user: User,
  name: string,
  role: keyof typeof ROLE_NAME,
) {
  const edit = await openEdit(user, name);
  await user.click(within(edit).getByRole("radio", { name: ROLE_NAME[role] }));
  await user.click(within(edit).getByRole("button", { name: "저장" }));
  return screen.findByRole("dialog", { name: /역할을 .+\(으\)로 바꿀까요\?/ });
}

/** Picks a role and goes through with it in the confirmation. */
async function changeRole(
  user: User,
  name: string,
  role: keyof typeof ROLE_NAME,
) {
  const dialog = await pickRole(user, name, role);
  await user.click(within(dialog).getByRole("button", { name: "역할 바꾸기" }));
}

/** The role badge in a member's row. */
function roleIn(name: string) {
  // Also while a dialog hides the page from the accessibility tree.
  const row = screen
    .getByRole("button", { name: `${name} 편집`, hidden: true })
    .closest("tr");
  return (row as HTMLElement).querySelectorAll("td")[1]?.textContent;
}

/** Whether 구성원 편집 lets the role change, and the reason when not. */
async function roleRule(user: User, name: string) {
  const edit = await openEdit(user, name);
  const radios = within(edit).getAllByRole("radio") as HTMLButtonElement[];
  const group = within(edit).getByRole("radiogroup");
  const rule = {
    disabled: radios.every((radio) => radio.disabled),
    reason: document.getElementById(
      group.getAttribute("aria-describedby") ?? "",
    )?.textContent,
  };
  await user.click(within(edit).getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  return rule;
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
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    expect(
      within(edit)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual([...WORKSPACE_ROLE_VALUES]);
    await user.click(within(edit).getByRole("button", { name: "취소" }));
    const region = screen.getByRole("region", { name: "구성원 표" });
    expect(
      within(region)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["구성원", "역할", "관리하는 에이전트", "마지막 활동", "관리"]);
    const mateRow = within(region)
      .getByRole("button", { name: "Mate 편집" })
      .closest("tr") as HTMLElement;
    expect(mateRow.textContent).toContain("mate@example.com");
    // GET /v1/members carries neither yet (94S-816).
    expect(within(mateRow).getAllByText("미계측")).toHaveLength(2);
    expect(roleIn("Mate")).toBe("구성원");
    expect(roleIn("Owner")).toBe("소유자");
    const goneRow = screen.getByText(/^Gone/).closest("tr");
    expect(goneRow?.getAttribute("data-disabled")).toBe("true");
    expect(within(goneRow as HTMLElement).getByText("비활성")).toBeDefined();
    expect(
      within(goneRow as HTMLElement).getByRole("button", {
        name: "다시 활성화",
      }),
    ).toBeDefined();
  });

  test("행에는 비활성화만 있고 역할 select는 없다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, teammate] }),
      ...noInvites,
    });
    const region = await screen.findByRole("region", { name: "구성원 표" });
    await screen.findByRole("button", { name: "Mate 편집" });
    expect(within(region).queryByRole("combobox")).toBeNull();
    expect(within(region).queryByRole("button", { name: /삭제/ })).toBeNull();
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
    await changeRole(user, "Mate", "owner");
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "PATCH")).toBe(true),
    );
    expect(roleIn("Mate")).toBe("구성원");
    expect(screen.queryByText(/역할을 소유자\(으\)로 바꿨습니다/)).toBeNull();
    release();
    expect(
      await screen.findByText("Mate의 역할을 소유자(으)로 바꿨습니다."),
    ).toBeDefined();
    await waitFor(() => expect(roleIn("Mate")).toBe("소유자"));
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ role: "owner" });
    expect(patch?.headers.get("x-requested-with")).toBe("agent-platform-web");
  });

  test("마지막 소유자(409 LAST_OWNER)는 행이 미리 막는 이유와 같은 말로 보인다", async () => {
    // The list still showed two owners when the other one left.
    const boss = member({
      user_id: GONE_ID,
      email: "boss@example.com",
      display_name: "Boss",
      role: "owner",
    });
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, boss, teammate] }),
      ...noInvites,
      [`PATCH /v1/members/${GONE_ID}`]: () =>
        apiError(409, "LAST_OWNER", "The last owner cannot be demoted"),
    });
    const user = await setupUser();
    await changeRole(user, "Boss", "member");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "하나뿐인 소유자의 역할은 바꿀 수 없습니다 — 다른 사람을 먼저 소유자로 정하세요.",
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
    await changeRole(user, "Mate", "owner");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "소유자 역할을 주거나 소유자의 역할·접근(비활성화·정지·다시 활성화)을 바꾸는 일은 소유자만 할 수 있습니다 — 소유자에게 요청하세요.",
    );
  });

  test("관리자는 비활성 소유자를 다시 활성화하지 못하고, 이유를 안내 버튼 뒤에 둔다", async () => {
    const boss = { ...gone, display_name: "Boss", role: "owner" as const };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(200, { items: [{ ...owner, role: "admin" }, teammate, boss] }),
      ...noInvites,
    });
    const row = (await screen.findByText("Boss")).closest("tr") as HTMLElement;
    const enable = within(row).getByRole("button", {
      name: "다시 활성화",
    }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(
      document.getElementById(enable.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("소유자는 관리자가 다시 활성화할 수 없습니다.");
    expect(
      within(row).getByRole("button", {
        name: "Boss을(를) 다시 활성화할 수 없는 이유",
      }),
    ).toBeDefined();
  });

  test("다시 활성화가 403 OWNER_PROTECTED로 거절되면 그 동작의 말로 보인다", async () => {
    const boss = { ...gone, display_name: "Boss", role: "owner" as const };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner, boss] }),
      ...noInvites,
      [`POST /v1/members/${GONE_ID}/enable`]: () =>
        apiError(403, "OWNER_PROTECTED", "Only an owner may enable an owner"),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "다시 활성화" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "소유자는 관리자가 다시 활성화할 수 없습니다.",
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
      await screen.findByText("Mate 계정을 비활성화했습니다."),
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
        return json(200, { member: current, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", { name: "다시 활성화" }),
    );
    expect(
      await screen.findByText(
        "Gone 계정을 다시 활성화했습니다. 이제 다시 로그인할 수 있습니다.",
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
    await user.click(
      await screen.findByRole("button", { name: "구성원 초대" }),
    );
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
      await user.click(
        await screen.findByRole("button", { name: "구성원 초대" }),
      );
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
    const user = await setupUser();
    const edit = await openEdit(user, "Mate");
    const save = within(edit).getByRole("button", {
      name: "저장",
    }) as HTMLButtonElement;
    // The role it already has is nothing to save.
    expect(save.disabled).toBe(true);
    await user.click(within(edit).getByRole("radio", { name: "관리자" }));
    await user.click(within(edit).getByRole("radio", { name: "소유자" }));
    expect(calls).toEqual([]);
    await user.click(save);
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
    const dialog = await pickRole(user, "Mate", "admin");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(roleIn("Mate")).toBe("구성원");
    expect(calls).toEqual([]);
  });

  test("편집을 닫으면 키보드가 그 이름 버튼으로 돌아온다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const name = await screen.findByRole("button", { name: "Mate 편집" });
    await openEdit(user, "Mate");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    const edit = await openEdit(user, "Mate");
    await user.click(within(edit).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
  });

  test("저장 뒤 확인창을 닫아도 키보드가 그 이름 버튼으로 돌아온다", async () => {
    const calls: string[] = [];
    renderAt("/members", routes(calls));
    const user = await setupUser();
    const name = await screen.findByRole("button", { name: "Mate 편집" });
    const confirm = await pickRole(user, "Mate", "admin");
    await waitFor(() =>
      expect(confirm.contains(document.activeElement)).toBe(true),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === name).toBe(true));
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
      reason: "소유자는 관리자가 비활성화할 수 없습니다.",
    });
    expect((await reasonOf("Mate")).disabled).toBe(false);
  });

  test("비활성 구성원의 역할은 편집에서 막고, 다시 활성화하라고 한다", async () => {
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(200, {
          items: [
            { ...owner, role: "admin" },
            {
              ...gone,
              display_name: "Boss",
              role: "owner",
            },
          ],
        }),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await roleRule(user, "Boss")).toEqual({
      disabled: true,
      reason: "비활성 구성원의 역할은 다시 활성화한 뒤 바꿀 수 있습니다.",
    });
  });

  test("역할도 같은 규칙으로 편집에서 막고, 비활성화 이유는 행 높이를 바꾸지 않는 안내 버튼 뒤에 둔다", async () => {
    const boss = member({
      user_id: GONE_ID,
      email: "boss@example.com",
      display_name: "Boss",
      role: "owner",
    });
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      "GET /v1/members": () =>
        json(200, { items: [{ ...owner, role: "admin" }, boss, teammate] }),
      ...noInvites,
    });
    const user = await setupUser();
    expect(await roleRule(user, "Owner")).toEqual({
      disabled: true,
      reason: "자기 자신의 역할은 바꿀 수 없습니다.",
    });
    expect(await roleRule(user, "Boss")).toEqual({
      disabled: true,
      reason: "소유자의 역할은 관리자가 바꿀 수 없습니다.",
    });
    expect((await roleRule(user, "Mate")).disabled).toBe(false);

    // Nothing under the control: the reason opens from the keyboard.
    const why = screen.getByRole("button", {
      name: "Boss을(를) 비활성화할 수 없는 이유",
    });
    expect(why.closest("td")?.textContent).toBe(
      "비활성화소유자는 관리자가 비활성화할 수 없습니다.",
    );
    why.focus();
    await user.keyboard("{Enter}");
    const note = await screen.findByRole("dialog", {
      name: "Boss을(를) 비활성화할 수 없는 이유",
    });
    expect(note.textContent).toBe("소유자는 관리자가 비활성화할 수 없습니다.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(why);
  });
});

describe("권한", () => {
  const forbidden = () =>
    apiError(403, "FORBIDDEN", "This principal does not hold member.manage");

  test("관리 권한이 없으면 초대 폼 대신 안내 한 줄만 보이고 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/members", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
    });
    expect(
      await screen.findByText(
        "구성원 초대와 관리는 워크스페이스 소유자나 관리자가 합니다.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("member.manage");
    expect(api.calls.some((c) => c.path.startsWith("/v1/members"))).toBe(false);
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
    await changeRole(user, "Mate", "owner");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });

  test("이 빌드가 모르는 역할이어도 서버가 목록을 주면 관리할 수 있다", async () => {
    const future = { ...me(undefined, "admin"), permissions: me().permissions };
    renderAt("/members", {
      "GET /v1/auth/me": () => json(200, future),
      "GET /v1/members": () => json(200, { items: [owner, teammate] }),
      ...noInvites,
    });
    const button = await screen.findByRole("button", {
      name: "구성원 초대",
    });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
