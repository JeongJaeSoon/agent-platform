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
    {
      "GET /v1/profiles": () => json(200, PROFILES),
      [`GET ${TOKEN}`]: () => json(200, UNSET_TOKEN),
      ...routes,
    },
    locale,
  );

function profile(id: string, model: string) {
  return {
    id,
    source: "operator",
    model,
    models: [model],
    tools: ["Read"],
    permission_mode: "default",
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "metered",
    repository_mode: "required",
  } as const;
}

const RETENTION = `/v1/workspaces/${WORKSPACE_ID}/audit-retention`;
const GUEST = `/v1/workspaces/${WORKSPACE_ID}/slack-guest`;
const TOKEN = `/v1/workspaces/${WORKSPACE_ID}/slack/config-token`;
const UNSET_TOKEN = {
  configured: false,
  last4: null,
  updated_at: null,
  updated_by: null,
  state: "unset",
  expires_at: null,
  issuer: null,
};
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
    const unit = input.nextElementSibling;
    expect(unit?.textContent).toBe("일");
    expect(unit?.getAttribute("aria-hidden")).toBe("true");
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
    const user = await setupUser();
    const save = await screen.findByRole("button", { name: "저장" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    // Still a submit button, and pressing it submits nothing.
    await user.click(save);
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
    const { api } = renderAt("/settings/workspace/slack", {
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
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(adminMe(), false)),
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const row = toggle.closest('[data-slot="setting-row"]');
    expect(row?.closest("section")?.getAttribute("aria-labelledby")).toBe(
      screen.getByRole("heading", { name: "Slack 게스트" }).id,
    );
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
    const { api } = renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), enabled)),
      [`POST ${GUEST}`]: async (request: Request) => {
        enabled = ((await request.json()) as { slack_guest_enabled: boolean })
          .slack_guest_enabled;
        return json(200, { slack_guest_enabled: enabled });
      },
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    const user = await setupUser();
    // The settings nav's last link comes right before the page.
    screen.getByRole("link", { name: "언어·테마" }).focus();
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
    const { api } = renderAt("/settings/workspace/slack", {
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
    const { api } = renderAt("/settings/workspace/slack", {
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
    const { api } = renderAt("/settings/workspace/slack", {
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
    const { api } = renderAt("/settings/workspace/slack", {
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
    renderAt("/settings/workspace/slack", {
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

  test("소유자·관리자의 설정 메뉴는 워크스페이스 일반으로 연다", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, adminMe()) });
    expect(
      (await screen.findByRole("link", { name: "설정" })).getAttribute("href"),
    ).toBe("/settings/workspace");
  });

  test("구성원의 사이드바에는 설정이 없다(내 설정은 계정 메뉴: layout.test)", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    await within(nav).findByRole("link", { name: "실행 프로필" });
    expect(within(nav).queryByRole("link", { name: "설정" })).toBeNull();
  });

  test("App Configuration Token을 넣으면 다시 읽은 상태와 지우는 칸이 보인다", async () => {
    let saved = false;
    const active = {
      ...UNSET_TOKEN,
      configured: true,
      last4: "abcd",
      state: "active",
      updated_at: "2026-10-25T05:00:00.000Z",
    };
    const { api, services } = renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, saved ? active : UNSET_TOKEN),
      [`PUT ${TOKEN}`]: () => {
        saved = true;
        return json(200, {
          ...active,
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          warnings: [],
        });
      },
    });
    expect(await screen.findByText("설정 안 됨")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "위험 구역" })).toBeNull();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "토큰 넣기" }));
    const input = screen.getByLabelText("새 App Configuration Token");
    expect(document.activeElement === input).toBe(true);
    await user.type(input, "fake-config-value");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "App Configuration Token을 저장했습니다.",
    );
    expect(
      api.calls.filter((c) => c.method === "PUT").map((c) => c.body),
    ).toEqual([{ value: "fake-config-value" }]);
    expect(await screen.findByText("설정됨")).toBeDefined();
    expect(screen.getByRole("heading", { name: "위험 구역" })).toBeDefined();
    // The form is gone; focus is on the button that opens it again.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("교체"),
    );
    // The value went to the server and nowhere else.
    await waitFor(() =>
      expect(
        JSON.stringify(
          services.queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.variables),
        ),
      ).not.toContain("fake-config-value"),
    );
  });

  test("저장 뒤 다시 읽기가 끝나지 않아도 token 값은 캐시에 남지 않는다", async () => {
    let saved = false;
    const { services } = renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      // The read after the save never answers.
      [`GET ${TOKEN}`]: () =>
        saved ? new Promise<Response>(() => {}) : json(200, UNSET_TOKEN),
      [`PUT ${TOKEN}`]: () => {
        saved = true;
        return json(200, {
          ...UNSET_TOKEN,
          configured: true,
          last4: "abcd",
          state: "active",
          updated_at: "2026-10-25T05:00:00.000Z",
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          warnings: [],
        });
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 넣기" }));
    await user.type(
      screen.getByLabelText("새 App Configuration Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    await screen.findByRole("status");
    await waitFor(() =>
      expect(
        JSON.stringify(
          services.queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.variables),
        ),
      ).not.toContain("fake-config-value"),
    );
  });

  test("token 칸을 취소하면 포커스가 칸을 연 버튼으로 돌아간다", async () => {
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 넣기" }));
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByLabelText("새 App Configuration Token")).toBeNull();
    expect(document.activeElement?.textContent).toBe("토큰 넣기");
  });

  const ACTIVE_TOKEN = {
    ...UNSET_TOKEN,
    configured: true,
    last4: "abcd",
    state: "active",
    updated_at: "2026-10-25T05:00:00.000Z",
    updated_by: {
      user_id: "11111111-1111-4111-8111-111111111111",
      display_name: "Kim",
    },
    issuer: { user_id: "U0ISSUER1", team_id: "T0TEAM001" },
  };

  test("설정된 token은 끝 네 글자, 저장한 사람, 발급자만 보인다", async () => {
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, ACTIVE_TOKEN),
    });
    expect(
      await screen.findByText(
        /^••••abcd · .+ 저장 · 저장한 사람 Kim · 발급자 U0ISSUER1$/,
      ),
    ).toBeDefined();
  });

  test("발급자가 바뀐 저장은 앞으로 만드는 앱의 협업자가 바뀐다고 알린다", async () => {
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`PUT ${TOKEN}`]: () =>
        json(200, {
          ...ACTIVE_TOKEN,
          receipt_id: "5f0c2c1e-8a4b-4c1d-9e2f-3a4b5c6d7e8f",
          warnings: [
            {
              code: "config_token_issuer_changed",
              previous_user_id: "U0PREVIOUS",
              user_id: "U0ISSUER1",
            },
          ],
        }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 넣기" }));
    await user.type(
      screen.getByLabelText("새 App Configuration Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "저장했습니다. 발급자가 바뀌어 앞으로 만드는 앱의 협업자도 바뀝니다.",
    );
  });

  test("token 저장을 서버가 403으로 거절하면 권한 문구이고 서버의 영어 문구는 없다", async () => {
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, adminMe()),
      [`PUT ${TOKEN}`]: () =>
        apiError(403, "FORBIDDEN", "Only an owner or admin can set it"),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 넣기" }));
    await user.type(
      screen.getByLabelText("새 App Configuration Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "워크스페이스 설정 변경 권한이 있어야 할 수 있습니다. 지금 역할: 관리자.",
    );
  });

  test("비밀 저장소가 꺼져 있으면 저장 실패를 관리자에게 확인할 일로 알린다", async () => {
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`PUT ${TOKEN}`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "The secret store is off"),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 넣기" }));
    await user.type(
      screen.getByLabelText("새 App Configuration Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
    );
  });

  test("잠깐 쓸 수 없는 서버는 저장소 문구가 아니라 다시 시도할 일로 알린다", async () => {
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`PUT ${TOKEN}`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Try again", true),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "토큰 넣기" }));
    await user.type(
      screen.getByLabelText("새 App Configuration Token"),
      "fake-config-value",
    );
    await user.click(screen.getByRole("button", { name: "저장" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("비밀 저장소");
    expect(alert.textContent).not.toContain("Try again");
  });

  test("비밀 저장소가 꺼져 있으면 token 상태 대신 관리자에게 확인할 일을 보이고, 다시 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "The secret store is off"),
    });
    expect(
      await screen.findByText(
        "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(
      api.calls.filter(
        (c) => c.method === "GET" && c.path.endsWith("/slack/config-token"),
      ),
    ).toHaveLength(1);
  });

  test("삭제를 비밀 저장소가 꺼져 거절하면 관리자에게 확인할 일로 알린다", async () => {
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () =>
        json(200, { ...UNSET_TOKEN, configured: true, state: "active" }),
      [`DELETE ${TOKEN}`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "The secret store is off"),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "비밀 저장소를 사용할 수 없습니다. 관리자에게 저장소 설정을 확인해 달라고 요청하세요.",
    );
  });

  test("이미 지워진 token을 삭제하면 다시 읽어 지워졌다고 알린다", async () => {
    let deleted = false;
    renderAt("/settings/workspace/slack", {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET ${TOKEN}`]: () => json(200, deleted ? UNSET_TOKEN : ACTIVE_TOKEN),
      [`DELETE ${TOKEN}`]: () => {
        deleted = true;
        return apiError(404, "NOT_FOUND", "Not found");
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "App Configuration Token을 삭제했습니다.",
    );
    expect(await screen.findByText("설정 안 됨")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("끝에 /가 붙은 주소에서도 설정 내비가 지금 페이지를 가리킨다", async () => {
    renderAt("/settings/workspace/", {
      "GET /v1/auth/me": () => json(200, me()),
    });
    const nav = await screen.findByRole("navigation", { name: "설정" });
    expect(
      within(nav)
        .getByRole("link", { name: "일반" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav).getByRole("button", { name: /^설정 · 일반/ }),
    ).toBeDefined();
  });
});
