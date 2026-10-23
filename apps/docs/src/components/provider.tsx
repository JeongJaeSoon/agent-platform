"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import SearchDialog from "@/components/search";

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
};

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{ SearchDialog }}
      i18n={{ locale: "ko", translations: ko }}
      // tokens.css switches on data-theme; Fumadocs' own styles on .dark.
      theme={{ attribute: ["class", "data-theme"] }}
    >
      {children}
    </RootProvider>
  );
}
