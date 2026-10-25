import { afterEach, describe, expect, test } from "bun:test";
import {
  flowEn,
  flowJa,
  flowKo,
  formsEn,
  formsJa,
  formsKo,
  sessionsEn,
  sessionsJa,
  sessionsKo,
} from "@werft-ai/react";
import { agentsEn, agentsJa, agentsKo } from "./agents.ts";
import { apiKeysEn, apiKeysJa, apiKeysKo } from "./api-keys.ts";
import { authEn, authJa, authKo } from "./auth.ts";
import { commonEn, commonJa, commonKo } from "./common.ts";
import { en, slackEn } from "./en.ts";
import { errorsEn, errorsJa, errorsKo } from "./errors.ts";
import { homeEn, homeJa, homeKo } from "./home.ts";
import {
  errorKey,
  initialLocale,
  LOCALE_NAMES,
  LOCALE_STORAGE_KEY,
  LOCALES,
  translate,
} from "./i18n.tsx";
import { ja, slackJa } from "./ja.ts";
import { ko, slackKo } from "./ko.ts";
import { linkedEn, linkedJa, linkedKo } from "./linked.ts";
import { membersEn, membersJa, membersKo } from "./members.ts";
import { modelsEn, modelsJa, modelsKo } from "./models.ts";
import { outputsEn, outputsJa, outputsKo } from "./outputs.ts";
import { preferencesEn, preferencesJa, preferencesKo } from "./preferences.ts";
import { sessionListEn, sessionListJa, sessionListKo } from "./session-list.ts";
import { shellEn, shellJa, shellKo } from "./shell.ts";
import { teamsEn, teamsJa, teamsKo } from "./teams.ts";
import { usageEn, usageJa, usageKo } from "./usage.ts";
import { workspaceEn, workspaceJa, workspaceKo } from "./workspace.ts";

const catalogs = { ko, ja, en } as const;
const variables = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("i18n", () => {
  test("every locale has exactly the Korean keys", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort()).toEqual(
        Object.keys(ko).sort(),
      );
    }
  });

  test("every message is written and keeps the Korean variables", () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(ko)) {
        const translated = catalogs[locale][key as keyof typeof ko];
        expect(translated.trim()).not.toBe("");
        expect(variables(translated)).toEqual(variables(text));
      }
    }
  });

  test("each language is named in its own words", () => {
    expect(LOCALE_NAMES).toEqual({ ko: "한국어", ja: "日本語", en: "English" });
  });

  // A key in two area files would silently win by spread order.
  test("no key is defined in two area files", () => {
    const count = (areas: object[]) =>
      areas.reduce((sum, area) => sum + Object.keys(area).length, 0);
    const areas = {
      ko: [
        slackKo,
        commonKo,
        shellKo,
        authKo,
        homeKo,
        membersKo,
        teamsKo,
        agentsKo,
        modelsKo,
        sessionsKo,
        sessionListKo,
        flowKo,
        linkedKo,
        outputsKo,
        apiKeysKo,
        workspaceKo,
        usageKo,
        preferencesKo,
        errorsKo,
        formsKo,
      ],
      ja: [
        slackJa,
        commonJa,
        shellJa,
        authJa,
        homeJa,
        membersJa,
        teamsJa,
        agentsJa,
        modelsJa,
        sessionsJa,
        sessionListJa,
        flowJa,
        linkedJa,
        outputsJa,
        apiKeysJa,
        workspaceJa,
        usageJa,
        preferencesJa,
        errorsJa,
        formsJa,
      ],
      en: [
        slackEn,
        commonEn,
        shellEn,
        authEn,
        homeEn,
        membersEn,
        teamsEn,
        agentsEn,
        modelsEn,
        sessionsEn,
        sessionListEn,
        flowEn,
        linkedEn,
        outputsEn,
        apiKeysEn,
        workspaceEn,
        usageEn,
        preferencesEn,
        errorsEn,
        formsEn,
      ],
    };
    for (const locale of LOCALES) {
      expect(count(areas[locale])).toBe(Object.keys(catalogs[locale]).length);
    }
  });

  test("keys follow <area>.<element>", () => {
    for (const key of Object.keys(ko)) {
      expect(key).toMatch(/^[a-z][A-Za-z]*(\.[a-zA-Z_][A-Za-z_]*)+$/);
    }
  });

  test("variables are filled; an unknown one is left as written", () => {
    expect(translate("ko", "bootstrap.passwordHint", { min: 12 })).toBe(
      "12자 이상",
    );
    expect(translate("ja", "bootstrap.passwordHint", { min: 12 })).toBe(
      "12文字以上",
    );
    expect(translate("en", "bootstrap.passwordHint")).toBe(
      "At least {min} characters",
    );
  });

  test("an error code without its own words falls back to the neutral one", () => {
    expect(errorKey("RATE_LIMITED")).toBe("error.RATE_LIMITED");
    expect(errorKey("SESSION_CLOSED")).toBe("error.UNKNOWN");
    expect(errorKey("__proto__")).toBe("error.UNKNOWN");
  });

  describe("initial locale", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const storage = new Map<string, string>();
    const setEnvironment = (
      languages: readonly string[],
      stored?: string,
      storageThrows = false,
    ) => {
      storage.clear();
      if (stored) storage.set(LOCALE_STORAGE_KEY, stored);
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { language: languages[0] ?? "", languages },
      });
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => {
            if (storageThrows) throw new Error("SecurityError");
            return storage.get(key) ?? null;
          },
        },
      });
    };
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      Reflect.deleteProperty(globalThis, "localStorage");
    });

    test("the first browser language the console speaks", () => {
      setEnvironment(["ko-KR"]);
      expect(initialLocale()).toBe("ko");
      setEnvironment(["ja-JP"]);
      expect(initialLocale()).toBe("ja");
      setEnvironment(["en-US"]);
      expect(initialLocale()).toBe("en");
      setEnvironment(["fr-FR", "ja", "en-US"]);
      expect(initialLocale()).toBe("ja");
    });

    test("English when no browser language is spoken here", () => {
      setEnvironment(["fr-FR", "de"]);
      expect(initialLocale()).toBe("en");
      setEnvironment([]);
      expect(initialLocale()).toBe("en");
    });

    test("a stored choice wins over the browser", () => {
      setEnvironment(["en-US"], "ja");
      expect(initialLocale()).toBe("ja");
      setEnvironment(["ko-KR"], "fr");
      expect(initialLocale()).toBe("ko");
    });

    test("blocked storage still falls back to the browser", () => {
      setEnvironment(["ja-JP"], "ko", true);
      expect(initialLocale()).toBe("ja");
    });
  });
});
