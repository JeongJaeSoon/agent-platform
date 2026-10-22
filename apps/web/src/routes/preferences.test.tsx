import { afterEach, describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { THEME_STORAGE_KEY } from "../components/theme.ts";
import { LOCALE_STORAGE_KEY } from "../i18n/i18n.tsx";
import { json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, cleanup, within } = await appHarness();

const signedIn = { "GET /v1/auth/me": () => json(200, me()) };

afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe("preferences", () => {
  test("language and theme are labelled radio groups, each language in its own words", async () => {
    renderAt("/settings/preferences", signedIn);
    expect(
      await screen.findByRole("heading", { level: 1, name: "내 설정" }),
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
    expect(start).not.toBe("個人設定");

    await user.click(screen.getByRole("radio", { name: /日本語/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "個人設定" }),
    ).toBeDefined();
    expect(document.documentElement.lang).toBe("ja");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ja");

    cleanup();
    renderAt("/settings/preferences", signedIn, null);
    expect(
      await screen.findByRole("heading", { level: 1, name: "個人設定" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("radio", { name: /日本語/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(screen.getByRole("radio", { name: /English/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "My settings" }),
    ).toBeDefined();
    cleanup();
    renderAt("/", signedIn, null);
    expect(
      await screen.findByRole("link", { name: "Language & theme" }),
    ).toBeDefined();
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
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: "어둡게" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await user.click(within(menu).getByRole("menuitemradio", { name: "밝게" }));
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
    await user.click(within(menu).getByRole("menuitem", { name: "言語" }));
    const languages = screen.getByRole("menu", { name: "言語" });
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
