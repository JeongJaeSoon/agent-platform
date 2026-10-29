import { afterEach, describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { THEME_STORAGE_KEY } from "../components/theme.ts";
import { LOCALE_STORAGE_KEY } from "../i18n/i18n.tsx";
import { json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, cleanup, within, waitFor } = await appHarness();

const signedIn = { "GET /v1/auth/me": () => json(200, me()) };

afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe("preferences", () => {
  test("language and theme are labelled radio groups, each language in its own words", async () => {
    renderAt("/settings/preferences", signedIn);
    expect(
      await screen.findByRole("heading", { level: 1, name: "언어·테마" }),
    ).toBeDefined();
    const language = screen.getByRole("radiogroup", { name: "언어" });
    expect(
      document.getElementById(language.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("메뉴와 안내 문구");
    const radios = within(language).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
      "ko",
      "ja",
      "en",
    ]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    expect(
      within(language).getByRole("radio", { name: /日本語/ }) === radios[1],
    ).toBe(true);
    expect(within(language).getByText("日本語").getAttribute("lang")).toBe(
      "ja",
    );
    expect(
      within(screen.getByRole("radiogroup", { name: "테마" }))
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "true"]);
    expect(
      screen.getByText("owner@example.com", { selector: "dd" }),
    ).toBeDefined();
  });

  test("a language chosen here applies at once and is still chosen on the next visit", async () => {
    renderAt("/settings/preferences", signedIn, null);
    const user = await setupUser();
    const start = (await screen.findByRole("heading", { level: 1 }))
      .textContent;
    expect(start).not.toBe("言語・テーマ");

    await user.click(screen.getByRole("radio", { name: /日本語/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "言語・テーマ" }),
    ).toBeDefined();
    expect(document.documentElement.lang).toBe("ja");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ja");

    cleanup();
    renderAt("/settings/preferences", signedIn, null);
    expect(
      await screen.findByRole("heading", { level: 1, name: "言語・テーマ" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("radio", { name: /日本語/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(screen.getByRole("radio", { name: /English/ }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Language & theme",
      }),
    ).toBeDefined();
    cleanup();
    renderAt("/", signedIn, null);
    expect(await screen.findByRole("link", { name: "Settings" })).toBeDefined();
  });

  test("the saved language wins when the console opens, and a language chosen here is saved for Slack", async () => {
    let saved: "ja" | "en" = "ja";
    const { api } = renderAt("/settings/preferences", {
      "GET /v1/auth/me": () =>
        json(200, { ...me(), user: { ...me().user, locale: saved } }),
      "PATCH /v1/auth/me": async (request) => {
        saved = ((await request.json()) as { locale: "en" }).locale;
        return new Response(null, { status: 204 });
      },
    });
    const user = await setupUser();
    expect(
      await screen.findByRole("heading", { level: 1, name: "言語・テーマ" }),
    ).toBeDefined();
    const saves = () =>
      api.calls.filter(
        (call) => call.method === "PATCH" && call.path === "/v1/auth/me",
      );
    expect(saves()).toEqual([]);

    await user.click(screen.getByRole("radio", { name: /English/ }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Language & theme",
      }),
    ).toBeDefined();
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]?.body).toEqual({ locale: "en" });
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path === "/v1/auth/me").at(-1)?.method,
      ).toBe("GET"),
    );
    expect(saves()).toHaveLength(1);
  });

  test("a user with no saved language saves the one this console shows", async () => {
    const { api } = renderAt("/settings/preferences", {
      ...signedIn,
      "PATCH /v1/auth/me": () => new Response(null, { status: 204 }),
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "언어·테마" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        api.calls
          .filter((call) => call.method === "PATCH")
          .map((call) => call.body),
      ).toEqual([{ locale: "ko" }]),
    );
  });

  test("theme and language chosen here show in the account menu at once, and the other way round", async () => {
    renderAt("/settings/preferences", signedIn);
    const user = await setupUser();
    const themes = await screen.findByRole("radiogroup", { name: "테마" });
    const openMenu = async () => {
      const region = screen.getByRole("region", { name: /メニュー|메뉴/ });
      await user.click(within(region).getByRole("button", { name: /Owner/ }));
      return screen.getByRole("menu", { name: /Owner/ });
    };

    await user.click(within(themes).getByRole("radio", { name: /어둡게/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    let menu = await openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: /^테마/ }));
    const themeMenu = screen.getByRole("menu", { name: /^테마/ });
    expect(
      within(themeMenu)
        .getByRole("menuitemradio", { name: "어둡게" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(
      within(themeMenu).getByRole("menuitemradio", { name: "밝게" }),
    );
    expect(
      within(themes)
        .getByRole("radio", { name: /밝게/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(
      within(screen.getByRole("radiogroup", { name: "언어" })).getByRole(
        "radio",
        { name: /日本語/ },
      ),
    );
    menu = await openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: /^言語/ }));
    const languages = screen.getByRole("menu", { name: /^言語/ });
    expect(
      within(languages)
        .getByRole("menuitemradio", { name: "日本語" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(
      within(languages).getByRole("menuitemradio", { name: "English" }),
    );
    expect(
      screen
        .getByRole("radio", { name: /English/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});
