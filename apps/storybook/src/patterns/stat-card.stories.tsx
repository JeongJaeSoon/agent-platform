import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, StatCard } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    sessions: "세션",
    week: "7일",
    sessionsNote: "지난주보다 12개 많음",
    approvals: "승인 대기",
    approvalsNote: "가장 오래된 요청 2시간 전",
    cost: "토큰 비용",
    costNote: "아직 집계되지 않았습니다",
  },
  ja: {
    sessions: "セッション",
    week: "7日",
    sessionsNote: "先週より12件多い",
    approvals: "承認待ち",
    approvalsNote: "最も古い依頼は2時間前",
    cost: "トークン費用",
    costNote: "まだ集計されていません",
  },
  en: {
    sessions: "Sessions",
    week: "7 days",
    sessionsNote: "12 more than last week",
    approvals: "Awaiting approval",
    approvalsNote: "Oldest request 2 hours ago",
    cost: "Token cost",
    costNote: "Not counted yet",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

const meta = {
  title: "Patterns/StatCard",
  component: StatCard,
  args: { label: COPY.ko.sessions, value: "128" },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <div className="max-w-[280px]">
        <StatCard
          {...args}
          label={copy.sessions}
          badge={<Badge>{copy.week}</Badge>}
          description={copy.sessionsNote}
        />
      </div>
    );
  },
} satisfies Meta<typeof StatCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/**
 * An agent's overview (mockup v4 L714): three cards on `grid-3`, 16px apart.
 * The last figure is not counted yet, so it is muted.
 */
export const Grid3: Story = {
  render: (_args, context) => {
    const copy = copyFor(context);
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label={copy.sessions}
          badge={<Badge>{copy.week}</Badge>}
          value="128"
          description={copy.sessionsNote}
        />
        <StatCard
          label={copy.approvals}
          value="3"
          description={copy.approvalsNote}
        />
        <StatCard
          label={copy.cost}
          value="—"
          muted
          description={copy.costNote}
        />
      </div>
    );
  },
};

export const Grid3Dark: Story = {
  ...Grid3,
  name: "Grid 3 (dark)",
  globals: { theme: "dark" },
};

export const Grid3Mobile: Story = {
  ...Grid3,
  name: "Grid 3 (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const Grid3English: Story = {
  ...Grid3,
  name: "Grid 3 (en)",
  globals: { locale: "en" },
};
