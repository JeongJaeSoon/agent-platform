import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const harness = await appHarness();
const { screen, waitFor, within } = harness;

const PROFILES = {
  items: [
    profile("claude-coding-fast", "claude-haiku-5"),
    profile("claude-coding-local", "claude-sonnet-5"),
    profile("claude-general", "claude-sonnet-5"),
  ],
};
// Every settings page reads the profile catalog for its model card.
const renderAt: typeof harness.renderAt = (path, routes, locale) =>
  harness.renderAt(
    path,
    { "GET /v1/profiles": () => json(200, PROFILES), ...routes },
    locale,
  );

function profile(id: string, model: string) {
  return {
    id,
    model,
    tools: ["Read"],
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "metered",
    repository_mode: "required",
  } as const;
}

const RETENTION = `/v1/workspaces/${WORKSPACE_ID}/audit-retention`;
const GUEST = `/v1/workspaces/${WORKSPACE_ID}/slack-guest`;
const adminMe = () => me(undefined, "admin");
const withGuest = (body: ReturnType<typeof me>, enabled: boolean) => ({
  ...body,
  workspace: body.workspace && {
    ...body.workspace,
    settings: { ...body.workspace.settings, slack_guest_enabled: enabled },
  },
});
const GUEST_SWITCH = { name: "Slack 게스트도 에이전트를 쓸 수 있게 하기" };

describe("워크스페이스 설정", () => {
  test("소유자는 보존 기간을 바꾸고, 저장한 값으로 다시 읽는다", async () => {
    let days = 90;
    const ownerMe = () => {
      const body = me();
      return {
        ...body,
        workspace: body.workspace && {
          ...body.workspace,
          settings: { ...body.workspace.settings, audit_retention_days: days },
        },
      };
    };
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, ownerMe()),
      [`POST ${RETENTION}`]: async (request: Request) => {
        days = ((await request.json()) as { audit_retention_days: number })
          .audit_retention_days;
        return json(200, { audit_retention_days: days });
      },
    });
    const input = (await screen.findByLabelText(
      "보존 기간(일)",
    )) as HTMLInputElement;
    expect(input.value).toBe("90");
    expect(
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent),
    ).toEqual([
      "허용·거절한 요청 기록을 이 기간 동안 보관합니다.",
      "30일보다 짧게 할 수 없고, 소유자만 바꿀 수 있습니다.",
    ]);
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "180");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "감사 기록을 180일 보존합니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "POST").map((c) => c.body),
    ).toEqual([{ audit_retention_days: 180 }]);
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.path === "/v1/auth/me").length,
      ).toBeGreaterThan(1),
    );
  });

  test("고치지 않은 입력은 다시 읽은 보존 기간을 따른다", async () => {
    let days = 90;
    const ownerMe = () => {
      const body = me();
      return {
        ...body,
        workspace: body.workspace && {
          ...body.workspace,
          settings: { ...body.workspace.settings, audit_retention_days: days },
        },
      };
    };
    const { services } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, ownerMe()),
    });
    const input = (await screen.findByLabelText(
      "보존 기간(일)",
    )) as HTMLInputElement;
    expect(input.value).toBe("90");
    // Another owner raised it; the next read brings the new value.
    days = 365;
    await services.queryClient.invalidateQueries({ queryKey: ["me"] });
    await waitFor(() => expect(input.value).toBe("365"));
  });

  test("저장하는 동안 고친 입력은 저장이 끝나도 남는다", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: async () => {
        await held;
        return json(200, { audit_retention_days: 180 });
      },
    });
    const input = (await screen.findByLabelText(
      "보존 기간(일)",
    )) as HTMLInputElement;
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "180");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await user.clear(input);
    await user.type(input, "200");
    release();
    expect((await screen.findByRole("status")).textContent).toBe(
      "감사 기록을 180일 보존합니다.",
    );
    expect(input.value).toBe("200");
  });

  test("30일보다 짧으면 서버가 거절하고 그 이유를 보인다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: () =>
        apiError(400, "BAD_REQUEST", "Invalid request body"),
    });
    const input = await screen.findByLabelText("보존 기간(일)");
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "29");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "감사 기록은 30일보다 짧게 보존할 수 없습니다. 30일 이상(최대 3650일)으로 정하세요.",
    );
    expect(
      api.calls.filter((c) => c.method === "POST").map((c) => c.body),
    ).toEqual([{ audit_retention_days: 29 }]);
  });

  test("화면의 최대치는 계약의 최대치와 같다", async () => {
    const { AUDIT_RETENTION_MAX_DAYS: contract } = await import(
      "@werft-ai/contracts"
    );
    const { AUDIT_RETENTION_MAX_DAYS } = await import(
      "./workspace-settings.tsx"
    );
    expect(AUDIT_RETENTION_MAX_DAYS).toBe(contract);
  });

  test("최대치를 넘기면 최대치를 넘겼다고 알린다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: () =>
        apiError(400, "BAD_REQUEST", "Invalid request body"),
    });
    const input = await screen.findByLabelText("보존 기간(일)");
    const user = await setupUser();
    await user.clear(input);
    await user.type(input, "99999");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "감사 기록은 최대 3650일까지 보존할 수 있습니다. 3650일 이하로 정하세요.",
    );
  });

  test("관리자는 화면을 보지만 저장은 이유와 함께 닫혀 있고, 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, adminMe()),
    });
    const save = await screen.findByRole("button", { name: "저장" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(save.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      "감사 기록 보존 기간 변경 권한이 있어야 할 수 있습니다. 지금 역할: 관리자.",
    );
    expect(
      (screen.getByLabelText("보존 기간(일)") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(api.calls.some((c) => c.path === RETENTION)).toBe(false);
  });

  test("서버가 403이면 같은 이유 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: () =>
        apiError(403, "FORBIDDEN", "Only an owner can change audit retention"),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "감사 기록 보존 기간 변경 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
  });

  test("관리자가 게스트 사용을 켜면 서버에 저장하고 다시 읽은 값으로 켜짐이다", async () => {
    let enabled = false;
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, withGuest(adminMe(), enabled)),
      [`POST ${GUEST}`]: async (request: Request) => {
        enabled = ((await request.json()) as { slack_guest_enabled: boolean })
          .slack_guest_enabled;
        return json(200, { slack_guest_enabled: enabled });
      },
    });
    const region = await screen.findByRole("region", { name: "Slack 게스트" });
    const toggle = within(region).getByRole("switch", GUEST_SWITCH);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("꺼짐")).toBeDefined();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("자기 Slack 계정을 연결해야");
    const user = await setupUser();
    await user.click(toggle);
    expect((await screen.findByRole("status")).textContent).toBe(
      "이제 Slack 게스트도 에이전트를 쓸 수 있습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }]);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getByText("켜짐")).toBeDefined();
  });

  test("게스트 스위치는 설정 행 컨트롤 칸의 마지막이고, 읽지 않는 켜짐·꺼짐 글자가 바로 앞에 있다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, withGuest(adminMe(), false)),
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const row = toggle.closest('[data-slot="setting-row"]');
    expect(
      row?.closest('[role="region"]')?.getAttribute("aria-labelledby"),
    ).toBe(screen.getByRole("heading", { name: "Slack 게스트" }).id);
    // bun's toBe passes on unrelated DOM nodes; compare elements with ===.
    const slot = toggle.parentElement;
    expect(slot?.lastElementChild === toggle).toBe(true);
    expect(slot?.parentElement?.parentElement === row).toBe(true);
    const status = toggle.previousElementSibling;
    expect(status?.textContent).toBe("꺼짐");
    expect(status?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      "꺼짐",
    );
    expect(row?.querySelector(`label[for="${toggle.id}"]`)?.textContent).toBe(
      GUEST_SWITCH.name,
    );
  });

  test("키보드로 스위치에 가서 Space로 켜고 Enter로 끈다", async () => {
    let enabled = false;
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), enabled)),
      [`POST ${GUEST}`]: async (request: Request) => {
        enabled = ((await request.json()) as { slack_guest_enabled: boolean })
          .slack_guest_enabled;
        return json(200, { slack_guest_enabled: enabled });
      },
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const user = await setupUser();
    screen.getByRole("button", { name: "저장" }).focus();
    await user.tab();
    expect(document.activeElement === toggle).toBe(true);
    await user.keyboard(" ");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }, { slack_guest_enabled: false }]);
  });

  test("저장 중에도 포커스가 스위치에 남고, 그동안 다시 누른 Space는 보내지 않는다", async () => {
    let enabled = false;
    let release = () => {};
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), enabled)),
      [`POST ${GUEST}`]: async (request: Request) => {
        const sent = (await request.json()) as { slack_guest_enabled: boolean };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        enabled = sent.slack_guest_enabled;
        return json(200, { slack_guest_enabled: enabled });
      },
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const user = await setupUser();
    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(document.activeElement === toggle).toBe(true);
    await user.keyboard(" ");
    release();
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(() =>
      expect(toggle.hasAttribute("aria-disabled")).toBe(false),
    );
    expect(document.activeElement === toggle).toBe(true);
    await user.keyboard(" ");
    release();
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }, { slack_guest_enabled: false }]);
  });

  test("라벨 글자를 눌러도 게스트 사용이 바뀐다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), false)),
      [`POST ${GUEST}`]: () => json(200, { slack_guest_enabled: true }),
    });
    await screen.findByRole("switch", GUEST_SWITCH);
    const user = await setupUser();
    await user.click(screen.getByText(GUEST_SWITCH.name));
    expect((await screen.findByRole("status")).textContent).toBe(
      "이제 Slack 게스트도 에이전트를 쓸 수 있습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }]);
  });

  test("보존 기간 저장 중에도 포커스가 저장 버튼에 남고, 다시 눌러도 한 번만 보낸다", async () => {
    let release = () => {};
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return json(200, { audit_retention_days: 90 });
      },
    });
    const button = await screen.findByRole("button", { name: "저장" });
    const user = await setupUser();
    await user.click(button);
    await waitFor(() =>
      expect(button.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(document.activeElement === button).toBe(true);
    await user.keyboard("{Enter}");
    release();
    expect((await screen.findByRole("status")).textContent).toContain("90");
    expect(document.activeElement === button).toBe(true);
    expect(api.calls.filter((c) => c.path === RETENTION)).toHaveLength(1);
  });

  test("워크스페이스 설정 권한이 없으면 스위치가 이유와 함께 닫혀 있고, 서버에 묻지 않는다", async () => {
    const body = me();
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () =>
        json(200, {
          ...body,
          permissions: body.permissions.filter((p) => p !== "workspace.manage"),
        }),
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(
      "워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: 소유자.",
    );
    const user = await setupUser();
    await user.click(toggle);
    expect(api.calls.some((c) => c.path === GUEST)).toBe(false);
  });

  test("켜져 있으면 끄는 값을 보낸다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), true)),
      [`POST ${GUEST}`]: () => json(200, { slack_guest_enabled: false }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("switch", GUEST_SWITCH));
    expect((await screen.findByRole("status")).textContent).toBe(
      "이제 Slack 게스트는 에이전트를 쓸 수 없습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: false }]);
  });

  test("구성원은 입력 칸 없이 지금 설정만 읽고, 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    expect(
      await screen.findByText("감사 기록을 90일 보존합니다."),
    ).toBeDefined();
    expect(
      screen.getByText("Slack 게스트는 에이전트를 쓸 수 없습니다."),
    ).toBeDefined();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(document.body.textContent).not.toContain(".manage");
    expect(
      api.calls.some((c) => c.path === GUEST || c.path === RETENTION),
    ).toBe(false);
  });

  test("게스트 설정을 서버가 403으로 거절하면 같은 이유 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, adminMe()),
      [`POST ${GUEST}`]: () =>
        apiError(
          403,
          "FORBIDDEN",
          "Only an owner or admin can change the Slack guest setting",
        ),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("switch", GUEST_SWITCH));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: 관리자.",
    );
  });

  test("이름과 ID는 읽기만 하고, 모델 허용 목록은 프로필의 모델을 한 번씩 보인다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const name = (await screen.findByRole("textbox", {
      name: "워크스페이스 이름",
    })) as HTMLInputElement;
    expect(name.value).toBe("Acme");
    expect(name.readOnly).toBe(true);
    expect(screen.getByText(WORKSPACE_ID).className).toContain("font-mono");
    const models = screen.getByRole("region", { name: "모델 허용 목록" });
    await waitFor(() =>
      expect(
        [...models.querySelectorAll("li")].map((li) => li.textContent),
      ).toEqual(["claude-haiku-5", "claude-sonnet-5"]),
    );
    // Only the retention card saves; the name and models have no API to.
    expect(screen.getAllByRole("button", { name: "저장" })).toHaveLength(1);
    expect(screen.getAllByText("읽기 전용")).toHaveLength(2);
  });

  test("ID를 복사하면 복사했다고 알린다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const user = await setupUser();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    await user.click(await screen.findByRole("button", { name: "복사" }));
    const message = await screen.findByText("워크스페이스 ID를 복사했습니다.");
    expect(message.closest("[aria-live=polite]")).not.toBeNull();
    expect(written).toEqual([WORKSPACE_ID]);
  });

  test("복사가 거절되면 직접 복사하라고 알리고 ID를 선택해 둔다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const user = await setupUser();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: "복사" }));
    const message = await screen.findByText(
      "복사하지 못했습니다. ID를 직접 선택해 복사하세요.",
    );
    expect(message.closest("[aria-live=polite]")).not.toBeNull();
    expect(globalThis.getSelection?.()?.toString()).toBe(WORKSPACE_ID);
  });

  test("프로필을 읽지 못하면 모델 카드에 다시 시도를 둔다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => apiError(500, "INTERNAL_ERROR", "boom"),
    });
    const models = await screen.findByRole("region", {
      name: "모델 허용 목록",
    });
    await waitFor(() =>
      expect(models.querySelector("[role=alert]")).not.toBeNull(),
    );
    expect(models.textContent).toContain("다시 시도");
  });

  test("등록된 모델이 없으면 없다고 말한다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/profiles": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText("이 설치에 등록된 모델이 없습니다."),
    ).toBeDefined();
  });

  test("메뉴는 소유자·관리자에게만 보인다", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, adminMe()) });
    expect(
      await screen.findByRole("link", { name: "워크스페이스 설정" }),
    ).toBeDefined();
  });

  test("구성원에게는 메뉴가 없다", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    await screen.findByRole("link", { name: "내 key" });
    expect(
      screen.queryByRole("link", { name: "워크스페이스 설정" }),
    ).toBeNull();
  });
});
