import { describe, expect, test } from "bun:test";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

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
const GUEST_SWITCH = { name: "Slack 게스트가 에이전트를 부를 수 있게 합니다" };

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
      "audit_retention.manage 권한이 있어야 할 수 있습니다. 지금 역할: 관리자.",
    );
    expect(
      (screen.getByLabelText("보존 기간(일)") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(api.calls.some((c) => c.path === RETENTION)).toBe(false);
  });

  test("서버가 403이면 같은 이유 문구와 서버 문구다", async () => {
    renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, me()),
      [`POST ${RETENTION}`]: () =>
        apiError(403, "FORBIDDEN", "Only an owner can change audit retention"),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "audit_retention.manage 권한이 있어야 할 수 있습니다. 지금 역할: 소유자. Only an owner can change audit retention",
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
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toBe("꺼짐");
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("자기 Slack 계정을 연결해야");
    const user = await setupUser();
    await user.click(toggle);
    expect((await screen.findByRole("status")).textContent).toBe(
      "Slack 게스트가 에이전트를 부를 수 있습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: true }]);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(toggle.textContent).toBe("켜짐");
  });

  test("켜져 있으면 끄는 값을 보낸다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, withGuest(me(), true)),
      [`POST ${GUEST}`]: () => json(200, { slack_guest_enabled: false }),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("switch", GUEST_SWITCH));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Slack 게스트는 에이전트를 부를 수 없습니다.",
    );
    expect(
      api.calls.filter((c) => c.path === GUEST).map((c) => c.body),
    ).toEqual([{ slack_guest_enabled: false }]);
  });

  test("구성원은 게스트 토글이 이유와 함께 닫혀 있고, 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/settings/workspace", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    const toggle = await screen.findByRole("switch", GUEST_SWITCH);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("workspace.manage 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.");
    expect(api.calls.some((c) => c.path === GUEST)).toBe(false);
  });

  test("게스트 설정을 서버가 403으로 거절하면 같은 이유 문구와 서버 문구다", async () => {
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
      "workspace.manage 권한이 있어야 할 수 있습니다. 지금 역할: 관리자. Only an owner or admin can change the Slack guest setting",
    );
  });

  test("메뉴는 소유자·관리자에게만 보인다", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, adminMe()) });
    expect(
      await screen.findByRole("link", { name: "워크스페이스 설정" }),
    ).toBeDefined();
  });

  test("구성원에게는 메뉴가 없다", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    await screen.findByRole("link", { name: "API key" });
    expect(
      screen.queryByRole("link", { name: "워크스페이스 설정" }),
    ).toBeNull();
  });
});
