import { sessionsEn, sessionsKo } from "./sessions.ts";

export { sessionsEn, sessionsKo };

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export type ModuleMessageKey = keyof typeof sessionsKo;
export type ModuleMessages = Readonly<Record<ModuleMessageKey, string>>;

export const defaultMessages: Readonly<Record<Locale, ModuleMessages>> = {
  ko: sessionsKo,
  en: sessionsEn,
};
