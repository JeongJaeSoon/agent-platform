import { flowEn, flowJa, flowKo } from "./flow.ts";
import { formsEn, formsJa, formsKo } from "./forms.ts";
import { sessionsEn, sessionsJa, sessionsKo } from "./sessions.ts";

export {
  flowEn,
  flowJa,
  flowKo,
  formsEn,
  formsJa,
  formsKo,
  sessionsEn,
  sessionsJa,
  sessionsKo,
};

export const LOCALES = ["ko", "ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export type ModuleMessageKey =
  | keyof typeof sessionsKo
  | keyof typeof flowKo
  | keyof typeof formsKo;
export type ModuleMessages = Readonly<Record<ModuleMessageKey, string>>;

export const defaultMessages: Readonly<Record<Locale, ModuleMessages>> = {
  ko: { ...sessionsKo, ...flowKo, ...formsKo },
  ja: { ...sessionsJa, ...flowJa, ...formsJa },
  en: { ...sessionsEn, ...flowEn, ...formsEn },
};
