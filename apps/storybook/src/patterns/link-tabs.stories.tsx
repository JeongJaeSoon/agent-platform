import type { Meta, StoryObj } from "@storybook/react-vite";
import { LinkTab, LinkTabs } from "@werft-ai/ui";
import { type MouseEvent, useState } from "react";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    keys: "API 키 종류",
    personal: "개인 키",
    service: "서비스 키",
    status: "세션 상태",
    all: "전체",
    running: "실행 중",
    needsInput: "답변 대기",
    ended: "끝남",
    settings: "에이전트 설정",
    sections: [
      "개요",
      "지침",
      "도구",
      "지식",
      "권한",
      "릴리스",
      "평가",
      "실행 기록",
      "알림",
      "고급",
    ],
  },
  ja: {
    keys: "API キーの種類",
    personal: "個人キー",
    service: "サービスキー",
    status: "セッションの状態",
    all: "すべて",
    running: "実行中",
    needsInput: "回答待ち",
    ended: "終了",
    settings: "エージェント設定",
    sections: [
      "概要",
      "指示",
      "ツール",
      "ナレッジ",
      "権限",
      "リリース",
      "評価",
      "実行履歴",
      "通知",
      "詳細",
    ],
  },
  en: {
    keys: "API key kinds",
    personal: "Personal keys",
    service: "Service keys",
    status: "Session status",
    all: "All",
    running: "Running",
    needsInput: "Waiting for reply",
    ended: "Ended",
    settings: "Agent settings",
    sections: [
      "Overview",
      "Instructions",
      "Tools",
      "Knowledge",
      "Permissions",
      "Releases",
      "Evaluations",
      "Run history",
      "Notifications",
      "Advanced",
    ],
  },
} as const;

type Locale = keyof typeof COPY;
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  const locale: Locale =
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko";
  return COPY[locale];
}

/*
 * The app decides which tab is current from its route; here a click stands in
 * for the navigation so the story's own iframe URL is left alone.
 */
function useCurrent(initial: string) {
  const [current, setCurrent] = useState(initial);
  const select = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    setCurrent(id);
  };
  return [current, select] as const;
}

function KeyTabs(context: Globals) {
  const copy = copyFor(context);
  const [current, select] = useCurrent("personal");
  return (
    <LinkTabs aria-label={copy.keys}>
      <LinkTab
        href="/api-keys"
        current={current === "personal"}
        onClick={select("personal")}
      >
        {copy.personal}
      </LinkTab>
      <LinkTab
        href="/api-keys/service"
        current={current === "service"}
        onClick={select("service")}
      >
        {copy.service}
      </LinkTab>
    </LinkTabs>
  );
}

// Demo counts; "ended" has none, so tabs with and without a badge share a row.
const STATUSES = [
  { id: "", key: "all", count: 128 },
  { id: "running", key: "running", count: 3 },
  { id: "needs_input", key: "needsInput", count: 0 },
  { id: "ended", key: "ended" },
] as const;

function SessionStatusTabs(context: Globals) {
  const copy = copyFor(context);
  const [current, select] = useCurrent("running");
  return (
    <LinkTabs aria-label={copy.status}>
      {STATUSES.map((status) => (
        <LinkTab
          key={status.key}
          href={status.id ? `?status=${status.id}` : "?"}
          current={current === status.id}
          count={"count" in status ? status.count : undefined}
          onClick={select(status.id)}
        >
          {copy[status.key]}
        </LinkTab>
      ))}
    </LinkTabs>
  );
}

function ManyTabs(context: Globals) {
  const copy = copyFor(context);
  const [current, select] = useCurrent("0");
  return (
    <LinkTabs aria-label={copy.settings}>
      {copy.sections.map((section, index) => (
        <LinkTab
          key={section}
          href={`#section-${index}`}
          current={current === String(index)}
          onClick={select(String(index))}
        >
          {section}
        </LinkTab>
      ))}
    </LinkTabs>
  );
}

const meta = {
  title: "Patterns/LinkTabs",
  component: LinkTabs,
  args: { "aria-label": COPY.ko.keys },
  render: (_args, context) => <KeyTabs {...context} />,
} satisfies Meta<typeof LinkTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Follows the toolbar's Language; the stories below pin each one. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/** Session list filters: `?status=` links with demo counts. */
export const SessionStatus: Story = {
  render: (_args, context) => <SessionStatusTabs {...context} />,
};

export const SessionStatusDark: Story = {
  ...SessionStatus,
  name: "SessionStatus (dark)",
  globals: { theme: "dark" },
};

export const SessionStatusJapanese: Story = {
  ...SessionStatus,
  name: "SessionStatus (ja)",
  globals: { locale: "ja" },
};

export const SessionStatusEnglish: Story = {
  ...SessionStatus,
  name: "SessionStatus (en)",
  globals: { locale: "en" },
};

/** More tabs than fit scroll sideways inside the nav; the page does not. */
export const Overflow: Story = {
  render: (_args, context) => <ManyTabs {...context} />,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const OverflowDark: Story = {
  ...Overflow,
  name: "Overflow (dark)",
  globals: {
    theme: "dark",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const Mobile: Story = {
  ...SessionStatus,
  name: "SessionStatus (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
