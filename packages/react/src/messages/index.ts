import { formsEn, formsKo } from "./forms.ts";
import { sessionsEn, sessionsKo } from "./sessions.ts";

export { formsEn, formsKo, sessionsEn, sessionsKo };

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export type ModuleMessageKey = keyof typeof sessionsKo | keyof typeof formsKo;
export type ModuleMessages = Readonly<Record<ModuleMessageKey, string>>;

export const defaultMessages: Readonly<Record<Locale, ModuleMessages>> = {
  ko: { ...sessionsKo, ...formsKo },
  en: { ...sessionsEn, ...formsEn },
};
