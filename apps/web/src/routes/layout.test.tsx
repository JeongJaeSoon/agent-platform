import { afterEach, describe, expect, test } from "bun:test";
import { queryKeys } from "@werft-ai/core";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { THEME_STORAGE_KEY } from "../components/theme.ts";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness, WAITING_SESSIONS } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const AT = "2026-10-11T08:14:02.000Z";
const waiting = (id: string) => ({
  id,
  revision: 1,
  admission_state: "active",
  status: "needs_input",
  runtime: {
    kind: "claude_agent_sdk",
    version: "1.0.0",
    profile_id: "default",
    model: "model-default",
    permission_mode: "default",
  },
  repository_id: "demo",
  current_turn_id: "1",
  queued_turn_count: 0,
  last_event_at: AT,
  created_at: AT,
  updated_at: AT,
});
const FIRST = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const SECOND = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const signedIn = { "GET /v1/auth/me": () => json(200, me()) };

afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe("app shell", () => {
  test("the sidebar groups work, workspace and personal settings", async () => {
    renderAt("/", signedIn);
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    const groups = within(nav).getAllByRole("group");
    expect(
      groups.map((group) =>
        within(group)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ),
    ).toEqual([
      ["홈", "세션", "에이전트"],
      ["구성원", "팀", "워크스페이스 설정"],
      ["연동 계정", "API key"],
    ]);
    expect(groups[0]?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(within(nav).getByRole("group", { name: "업무" })).toBeDefined();
  });

  test("a member is not offered the screens that need management rights", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    await within(nav).findByRole("link", { name: "팀" });
    expect(within(nav).queryByRole("link", { name: "구성원" })).toBeNull();
    expect(
      within(nav).queryByRole("link", { name: "워크스페이스 설정" }),
    ).toBeNull();
  });

  test("the page header names the group and the page", async () => {
    renderAt("/settings/api-keys", signedIn);
    const header = await screen.findByRole("banner");
    await waitFor(() =>
      expect(header.textContent).toBe("메뉴 열기내 설정/API key"),
    );
  });

  test("lists and forms take different widths", async () => {
    renderAt("/", signedIn);
    await screen.findByRole("heading", { name: "Acme" });
    expect(document.getElementById("main")?.className).toContain(
      "max-w-[var(--ap-layout-content-width)]",
    );
  });

  test("the sessions item counts the sessions waiting for an answer", async () => {
    const { api } = renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () =>
        json(200, {
          items: [waiting(FIRST), waiting(SECOND)],
          next_cursor: null,
        }),
    });
    const link = await screen.findByRole("link", {
      name: "세션 답변 대기 2개",
    });
    expect(link.getAttribute("href")).toBe("/sessions");
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/sessions" && call.search === "?status=needs_input",
      ),
    ).toBe(true);
  });

  test("the badge reads again when the core's waiting key goes stale", async () => {
    let answered = 0;
    const { services } = renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () =>
        json(200, {
          items: answered++ === 0 ? [waiting(FIRST)] : [],
          next_cursor: null,
        }),
    });
    await screen.findByRole("link", { name: "세션 답변 대기 1개" });
    // What a session's status event invalidates.
    await services.queryClient.invalidateQueries({
      queryKey: queryKeys.waitingSessions,
      exact: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "세션" })).toBeDefined(),
    );
  });

  test("a first page with more behind it reads as at least that many", async () => {
    renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () =>
        json(200, { items: [waiting(FIRST)], next_cursor: "next-1" }),
    });
    const link = await screen.findByRole("link", {
      name: "세션 답변 대기 1개 이상",
    });
    expect(link.textContent).toContain("1+");
  });

  test("retry on the shell's error screen asks who is signed in again", async () => {
    let failures = 1;
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () =>
        failures-- > 0
          ? json(500, { error: { code: "INTERNAL" } })
          : json(200, me()),
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeDefined();
    expect(
      api.calls.filter((call) => call.path === "/v1/auth/me"),
    ).toHaveLength(2);
  });

  test("nothing waiting, or a list that failed, shows no badge", async () => {
    renderAt("/", {
      ...signedIn,
      [WAITING_SESSIONS]: () => json(500, { error: { code: "INTERNAL" } }),
    });
    const link = await screen.findByRole("link", { name: "세션" });
    expect(link.textContent).toBe("세션");
  });

  test("the user menu holds language, theme and logout, once", async () => {
    renderAt("/", signedIn);
    const menu = await screen.findByRole("region", { name: "사용자 메뉴" });
    expect(within(menu).getByText("owner@example.com")).toBeDefined();
    expect(
      within(menu).getByRole("button", { name: "로그아웃" }),
    ).toBeDefined();
    expect(screen.getAllByLabelText("언어")).toHaveLength(1);

    const user = await setupUser();
    await user.selectOptions(within(menu).getByLabelText("테마"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    await user.selectOptions(within(menu).getByLabelText("테마"), "system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  test("a stored theme applies on the next load", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderAt("/login", {});
    await screen.findByRole("heading", { name: "로그인" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  test("the menu button opens the sidebar and a link followed closes it", async () => {
    renderAt("/", signedIn);
    const toggle = await screen.findByRole("button", { name: "메뉴 열기" });
    const sidebar = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(sidebar?.dataset.open).toBe("false");
    const user = await setupUser();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar?.dataset.open).toBe("true");
    await user.click(
      within(sidebar as HTMLElement).getByRole("link", { name: "팀" }),
    );
    expect(sidebar?.dataset.open).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "메뉴 열기" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(document.activeElement?.id).toBe("main");
  });
});
