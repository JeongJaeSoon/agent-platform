import { afterEach, describe, expect, test } from "bun:test";
import {
  flowEn,
  flowKo,
  sessionsEn,
  sessionsKo,
} from "@agent-platform/react";
import { agentsEn, agentsKo } from "./agents.ts";
import { apiKeysEn, apiKeysKo } from "./api-keys.ts";
import { authEn, authKo } from "./auth.ts";
import { commonEn, commonKo } from "./common.ts";
import { en } from "./en.ts";
import { errorsEn, errorsKo } from "./errors.ts";
import { homeEn, homeKo } from "./home.ts";
import {
  errorKey,
  initialLocale,
  LOCALE_STORAGE_KEY,
  translate,
} from "./i18n.tsx";
import { ko } from "./ko.ts";
import { linkedEn, linkedKo } from "./linked.ts";
import { membersEn, membersKo } from "./members.ts";
import { modelsEn, modelsKo } from "./models.ts";
import { teamsEn, teamsKo } from "./teams.ts";
import { workspaceEn, workspaceKo } from "./workspace.ts";

describe("i18n", () => {
  test("every locale has exactly the Korean keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
  });

  // A key in two area files would silently win by spread order.
  test("no key is defined in two area files", () => {
    const count = (areas: object[]) =>
      areas.reduce((sum, area) => sum + Object.keys(area).length, 0);
    expect(
      count([
        commonKo,
        authKo,
        homeKo,
        membersKo,
        teamsKo,
        agentsKo,
        modelsKo,
        sessionsKo,
        flowKo,
        linkedKo,
        apiKeysKo,
        workspaceKo,
        errorsKo,
      ]),
    ).toBe(Object.keys(ko).length);
    expect(
      count([
        commonEn,
        authEn,
        homeEn,
        membersEn,
        teamsEn,
        agentsEn,
        modelsEn,
        sessionsEn,
        flowEn,
        linkedEn,
        apiKeysEn,
        workspaceEn,
        errorsEn,
      ]),
    ).toBe(Object.keys(en).length);
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
    const setEnvironment = (language: string, stored?: string) => {
      storage.clear();
      if (stored) storage.set(LOCALE_STORAGE_KEY, stored);
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { language },
      });
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: (key: string) => storage.get(key) ?? null },
      });
    };
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      Reflect.deleteProperty(globalThis, "localStorage");
    });

    test("Korean unless the browser asks for English", () => {
      setEnvironment("ko-KR");
      expect(initialLocale()).toBe("ko");
      setEnvironment("ja-JP");
      expect(initialLocale()).toBe("ko");
      setEnvironment("en-US");
      expect(initialLocale()).toBe("en");
    });

    test("a stored choice wins over the browser", () => {
      setEnvironment("en-US", "ko");
      expect(initialLocale()).toBe("ko");
      setEnvironment("ko-KR", "fr");
      expect(initialLocale()).toBe("ko");
    });
  });
});
