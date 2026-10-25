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
  model: "model-default",
  last_event_at: AT,
  created_at: AT,
  updated_at: AT,
});
const FIRST = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const SECOND = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const signedIn = { "GET /v1/auth/me": () => json(200, me()) };

// The column inside <main> that centres up to the screen's width.
const contentColumn = () =>
  document.getElementById("main")?.firstElementChild as HTMLElement | null;

afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe("app shell", () => {
  test("the sidebar groups work and the workspace, settings behind one item", async () => {
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
      ["홈", "세션", "에이전트", "운영"],
      ["구성원", "설정"],
    ]);
    expect(groups[0]?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(within(nav).getByRole("group", { name: "업무" })).toBeDefined();
  });

  test("a member is not offered the screens that need management rights", async () => {
    renderAt("/", { "GET /v1/auth/me": () => json(200, memberMe()) });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    // 구성원 holds the teams a member is in, so everyone has it.
    await within(nav).findByRole("link", { name: "구성원" });
    expect(within(nav).queryByRole("link", { name: "팀" })).toBeNull();
    // Their settings open on the person's own pages.
    expect(
      within(nav).getByRole("link", { name: "설정" }).getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test("the top bar names the page with the sidebar's words", async () => {
    renderAt("/settings/api-keys", signedIn);
    // The page head is a <header> too; the top bar comes first.
    const [header] = await screen.findAllByRole("banner");
    await waitFor(() => expect(header?.textContent).toBe("메뉴 열기API key"));
  });

  // V4-PAGE-FRAME: settings and forms used to stop at 1100px.
  for (const [path, title] of [
    ["/settings/api-keys", "API key"],
    ["/settings/workspace", "일반"],
    ["/settings/workspace/", "일반"],
    ["/settings/workspace/slack", "Slack 연결 설정"],
    ["/settings/preferences", "언어·테마"],
    ["/settings/linked-accounts", "연동 계정"],
    ["/settings/api-keys/new", "새 개인 key"],
  ] as const) {
    test(`${path} sits in the one page frame`, async () => {
      renderAt(path, signedIn);
      await screen.findByRole("heading", { level: 1, name: title });
      const frame = contentColumn();
      expect(frame?.dataset.slot).toBe("page-frame");
      expect(frame?.className).toContain("md:px-6");
      expect(
        frame?.querySelector('[data-slot="page-frame-body"]')?.className,
      ).toContain("max-w-[var(--ap-w-page)]");
    });
  }

  // Home and the sessions list open a waiting session in a rail at the
  // screen's edge, so they frame their own body, in the same frame.
  for (const [path, title] of [
    ["/", "홈"],
    ["/sessions", "세션"],
  ] as const) {
    test(`${path} frames its body beside the rail`, async () => {
      renderAt(path, signedIn);
      await screen.findByRole("heading", { level: 1, name: title });
      expect(contentColumn()?.dataset.slot).toBe("page-flush");
      const frame = document.querySelector<HTMLElement>(
        '[data-slot="detail-layout"] > [data-slot="page-frame"]',
      );
      expect(frame?.className).toContain("md:px-6");
      expect(
        frame?.querySelector('[data-slot="page-frame-body"]')?.className,
      ).toContain("max-w-[var(--ap-w-page)]");
    });
  }

  // One form or settings column stops inside the frame; lists use it all.
  for (const [path, title, width] of [
    ["/sessions", "세션", "full"],
    ["/settings/api-keys", "API key", "full"],
    ["/settings/workspace", "일반", "form"],
    ["/settings/preferences", "언어·테마", "form"],
    ["/settings/linked-accounts", "연동 계정", "form"],
    ["/settings/api-keys/new", "새 개인 key", "form"],
    ["/agents/new", "새 에이전트", "form"],
  ] as const) {
    test(`${path} takes the ${width} column`, async () => {
      renderAt(path, signedIn);
      const heading = await screen.findByRole("heading", {
        level: 1,
        name: title,
      });
      expect(
        heading
          .closest('[data-slot="page"]')
          ?.querySelector("[data-width]")
          ?.getAttribute("data-width"),
      ).toBe(width);
    });
  }

  test("a session's detail lays out the whole area itself", async () => {
    renderAt(`/sessions/${FIRST}`, signedIn);
    await waitFor(() =>
      expect(contentColumn()?.dataset.slot).toBe("page-flush"),
    );
    const main = document.getElementById("main");
    expect(main?.className).not.toContain("p-4");
    expect(contentColumn()?.className).not.toContain("max-w-");
  });

  test("the top bar makes nothing; each list offers its own", async () => {
    renderAt("/sessions", signedIn);
    const [header] = await screen.findAllByRole("banner");
    await within(header as HTMLElement).findByText("세션");
    expect(within(header as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(header as HTMLElement).queryByText("새로 만들기")).toBeNull();
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
    expect(await screen.findByRole("heading", { name: "홈" })).toBeDefined();
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

  test("the account menu holds linked accounts, language, theme, keys and logout", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const trigger = within(region).getByRole("button", {
      name: "Owner · 소유자",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);

    const user = await setupUser();
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "Owner · 소유자" });
    expect(within(menu).getByText("owner@example.com")).toBeDefined();
    expect(within(menu).getByText("소유자 · Acme")).toBeDefined();
    // Each submenu item shows its current value after the label.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "연동 계정",
      "언어한국어",
      "테마시스템 설정",
      "API key",
      "로그아웃",
    ]);
    expect(
      within(menu)
        .getByRole("menuitem", { name: "API key" })
        .getAttribute("href"),
    ).toBe("/settings/api-keys");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "연동 계정" })
        .getAttribute("href"),
    ).toBe("/settings/linked-accounts");

    await user.click(within(menu).getByRole("menuitem", { name: /^테마/ }));
    await user.click(
      within(screen.getByRole("menu", { name: /^테마/ })).getByRole(
        "menuitemradio",
        { name: "어둡게" },
      ),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.queryByRole("menu", { name: /^테마/ })).toBeNull();
    const themeItem = within(menu).getByRole("menuitem", { name: /^테마/ });
    expect(themeItem.textContent).toBe("테마어둡게");
    await user.click(themeItem);
    expect(
      within(screen.getByRole("menu", { name: /^테마/ }))
        .getByRole("menuitemradio", { name: "어둡게" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(
      within(screen.getByRole("menu", { name: /^테마/ })).getByRole(
        "menuitemradio",
        { name: "시스템 설정" },
      ),
    );
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await user.click(within(menu).getByRole("menuitem", { name: /^언어/ }));
    const languages = screen.getByRole("menu", { name: /^언어/ });
    expect(
      within(languages)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["한국어", "日本語", "English"]);
    await user.click(
      within(languages).getByRole("menuitemradio", { name: "English" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: /^Language/ }),
    ).toBeDefined();
  });

  test("following a link in the account menu puts focus on the page", async () => {
    const { history } = renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    await user.click(within(region).getByRole("button", { name: /Owner/ }));
    await user.click(screen.getByRole("menuitem", { name: "API key" }));
    expect(history.location.pathname).toBe("/settings/api-keys");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement?.id).toBe("main");
  });

  // happy-dom has no layout; the width at 390px is measured in the browser.
  test("below md the account menu spans the whole user bar, not the pill", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const user = await setupUser();
    await user.click(within(region).getByRole("button", { name: /Owner/ }));
    const menu = screen.getByRole("menu", { name: /Owner/ });
    expect(menu.classList.contains("inset-x-0")).toBe(true);
    let anchor = menu.parentElement;
    while (anchor && !anchor.classList.contains("relative")) {
      anchor = anchor.parentElement;
    }
    expect(anchor?.contains(region)).toBe(true);
    expect(
      anchor?.querySelector('a[href="/sessions"][aria-label]'),
    ).not.toBeNull();
  });

  test("the account menu works from the keyboard", async () => {
    renderAt("/", signedIn);
    const region = await screen.findByRole("region", { name: "사용자 메뉴" });
    const trigger = within(region).getByRole("button", { name: /Owner/ });
    const user = await setupUser();
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("연동 계정");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("한국어");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("日本語");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("English");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: /^언어/ })).toBeNull();
    expect(document.activeElement?.textContent).toBe("언어한국어");
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("시스템 설정");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("테마시스템 설정");
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("로그아웃");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement === trigger).toBe(true);

    await user.click(trigger);
    await user.click(screen.getByRole("link", { name: "구성원" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
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
      within(sidebar as HTMLElement).getByRole("link", { name: "구성원" }),
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
