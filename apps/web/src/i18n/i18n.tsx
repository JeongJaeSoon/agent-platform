import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { en } from "./en.ts";
import { ko, type MessageKey } from "./ko.ts";

export type { MessageKey };
export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

const catalogs: Record<Locale, Record<MessageKey, string>> = { ko, en };
export const LOCALE_STORAGE_KEY = "ap.locale";

export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  return catalogs[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

/** Error guidance for a server `error.code`, or the neutral fallback. */
export function errorKey(code: string): MessageKey {
  const key = `error.${code}`;
  return Object.hasOwn(ko, key) ? (key as MessageKey) : "error.UNKNOWN";
}

function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

/** A stored choice first, then the browser's language; Korean otherwise. */
export function initialLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage can be blocked; the browser language still decides.
  }
  const language = globalThis.navigator?.language ?? "";
  return language.toLowerCase().startsWith("en") ? "en" : "ko";
}

interface I18nValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  children,
  locale: fixed,
}: {
  readonly children: ReactNode;
  readonly locale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => fixed ?? initialLocale(),
  );
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Not remembered across visits; this visit still switches.
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale, setLocale],
  );
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
