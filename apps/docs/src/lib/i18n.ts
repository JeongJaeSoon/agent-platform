import { defineI18n } from "fumadocs-core/i18n";

export const i18n = defineI18n({
  languages: ["ko", "ja", "en"],
  defaultLanguage: "ko",
  // A translation sits beside its Korean source: `quickstart.ja.mdx`.
  parser: "dot",
});

export type Locale = (typeof i18n.languages)[number];

export function isLocale(value: unknown): value is Locale {
  return i18n.languages.includes(value as Locale);
}

// Read by the inline redirect script before React loads, so it stays a plain string.
export const localeStorageKey = "werft-docs-locale";

export const localeNames: Record<Locale, string> = {
  ko: "한국어",
  ja: "日本語",
  en: "English",
};

interface Messages {
  siteTitle: string;
  siteDescription: string;
  homeLead: string;
  untranslated: string;
}

export const messages: Record<Locale, Messages> = {
  ko: {
    siteTitle: "Werft 문서",
    siteDescription: "Werft 개발자 문서",
    homeLead:
      "격리된 worker에서 Claude Agent SDK 세션을 실행하고, 시작·이벤트·승인·제어를 HTTP API로 다루는 플랫폼입니다.",
    untranslated: "",
  },
  ja: {
    siteTitle: "Werft ドキュメント",
    siteDescription: "Werft 開発者ドキュメント",
    homeLead:
      "隔離された worker で Claude Agent SDK のセッションを実行し、開始・イベント・承認・制御を HTTP API で扱うプラットフォームです。",
    untranslated:
      "このページはまだ日本語に翻訳されていません。韓国語の原文を表示しています。",
  },
  en: {
    siteTitle: "Werft Docs",
    siteDescription: "Werft developer documentation",
    homeLead:
      "A platform that runs Claude Agent SDK sessions in isolated workers and exposes start, events, approvals and control over an HTTP API.",
    untranslated:
      "This page has not been translated into English yet. It is shown in the original Korean.",
  },
};

/** Content links are written as `/sessions/start`; each language links within itself. */
export function localizeHref(href: string, lang: Locale): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  return isLocale(href.split("/")[1]) ? href : `/${lang}${href}`;
}
