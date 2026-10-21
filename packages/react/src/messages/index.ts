import { flowEn, flowKo } from "./flow.ts";
import { sessionsEn, sessionsKo } from "./sessions.ts";

export { flowEn, flowKo, sessionsEn, sessionsKo };

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export type ModuleMessageKey = keyof typeof sessionsKo | keyof typeof flowKo;
export type ModuleMessages = Readonly<Record<ModuleMessageKey, string>>;

export const defaultMessages: Readonly<Record<Locale, ModuleMessages>> = {
  ko: { ...sessionsKo, ...flowKo },
  en: { ...sessionsEn, ...flowEn },
};
