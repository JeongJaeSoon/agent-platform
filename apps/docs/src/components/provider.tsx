"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import SearchDialog from "@/components/search";
import { i18n, type Locale, localeNames, localeStorageKey } from "@/lib/i18n";

// Fumadocs' own strings are English; its keys are the English text.
const ko: Record<string, string> = {
  "On this page(table of contents)": "이 페이지",
  "No Headings(table of contents)": "제목 없음",
  "Search(search trigger)": "검색",
  "Search(search dialog)": "검색",
  "Open Search(search trigger)(aria-label)": "검색 열기",
  "Close Search(search dialog)(aria-label)": "검색 닫기",
  "No results found(search dialog)": "결과가 없습니다",
  "Search failed(search dialog)": "검색하지 못했습니다",
  "Copy Markdown(page actions)": "Markdown으로 복사",
  "Copied Markdown(page actions)": "복사했습니다",
  "Copy Text(code block)(aria-label)": "코드 복사",
  "Copied Text(code block)(aria-label)": "복사했습니다",
  "Copy Anchor Link(heading anchor)(aria-label)": "제목 링크 복사",
  "Copied Anchor Link(heading anchor)(aria-label)": "링크를 복사했습니다",
  "Next Page(pagination)": "다음",
  "Previous Page(pagination)": "이전",
  "Open Sidebar(aria-label)": "사이드바 열기",
  "Open Sidebar(sidebar)(aria-label)": "사이드바 열기",
  "Close Sidebar(aria-label)": "사이드바 닫기",
  "Close Sidebar(sidebar)(aria-label)": "사이드바 닫기",
  "Collapse Sidebar(sidebar)(aria-label)": "사이드바 접기",
  "Theme(site menu)": "테마",
  "Light(theme switcher)(aria-label)": "라이트",
  "Dark(theme switcher)(aria-label)": "다크",
  "System(theme switcher)(aria-label)": "시스템",
  "Page Not Found(404 not found page)": "페이지를 찾을 수 없습니다",
  "Back to Home(404 not found page)": "홈으로",
  "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 not found page)":
    "찾는 페이지가 없거나 주소가 바뀌었습니다.",
  "Choose a language(language switcher)": "언어 선택",
  "Choose a language(language switcher)(aria-label)": "언어 선택",
};

const ja: Record<string, string> = {
  "On this page(table of contents)": "このページ",
  "No Headings(table of contents)": "見出しがありません",
  "Search(search trigger)": "検索",
  "Search(search dialog)": "検索",
  "Open Search(search trigger)(aria-label)": "検索を開く",
  "Close Search(search dialog)(aria-label)": "検索を閉じる",
  "No results found(search dialog)": "結果がありません",
  "Search failed(search dialog)": "検索できませんでした",
  "Copy Markdown(page actions)": "Markdown をコピー",
  "Copied Markdown(page actions)": "コピーしました",
  "Copy Text(code block)(aria-label)": "コードをコピー",
  "Copied Text(code block)(aria-label)": "コピーしました",
  "Copy Anchor Link(heading anchor)(aria-label)": "見出しのリンクをコピー",
  "Copied Anchor Link(heading anchor)(aria-label)": "リンクをコピーしました",
  "Next Page(pagination)": "次へ",
  "Previous Page(pagination)": "前へ",
  "Open Sidebar(aria-label)": "サイドバーを開く",
  "Open Sidebar(sidebar)(aria-label)": "サイドバーを開く",
  "Close Sidebar(aria-label)": "サイドバーを閉じる",
  "Close Sidebar(sidebar)(aria-label)": "サイドバーを閉じる",
  "Collapse Sidebar(sidebar)(aria-label)": "サイドバーを折りたたむ",
  "Theme(site menu)": "テーマ",
  "Light(theme switcher)(aria-label)": "ライト",
  "Dark(theme switcher)(aria-label)": "ダーク",
  "System(theme switcher)(aria-label)": "システム",
  "Page Not Found(404 not found page)": "ページが見つかりません",
  "Back to Home(404 not found page)": "ホームへ",
  "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 not found page)":
    "お探しのページは存在しないか、アドレスが変わりました。",
  "Choose a language(language switcher)": "言語を選択",
  "Choose a language(language switcher)(aria-label)": "言語を選択",
};

const translations: Record<Locale, Record<string, string>> = { ko, ja, en: {} };
const locales = i18n.languages.map((locale) => ({
  locale,
  name: localeNames[locale],
}));

export function Provider({
  lang,
  children,
}: {
  lang: Locale;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <RootProvider
      search={{ SearchDialog }}
      i18n={{
        locale: lang,
        locales,
        translations: translations[lang],
        onLocaleChange(next) {
          try {
            localStorage.setItem(localeStorageKey, next);
          } catch {
            // Blocked storage: the switch still works, it is just not remembered.
          }
          // Same page in the other language: swap the first path segment.
          router.push(`/${next}${pathname.slice(lang.length + 1)}`);
        },
      }}
      // tokens.css switches on data-theme; Fumadocs' own styles on .dark.
      theme={{ attribute: ["class", "data-theme"] }}
    >
      {children}
    </RootProvider>
  );
}
