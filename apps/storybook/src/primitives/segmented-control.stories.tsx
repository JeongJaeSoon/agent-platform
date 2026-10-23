import type { Meta, StoryObj } from "@storybook/react-vite";
import { SegmentedControl, SegmentedControlItem } from "@werft-ai/ui";
import { LayoutGrid, Table2 } from "lucide-react";
import { useState } from "react";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    status: "세션 상태",
    all: "전체",
    running: "실행 중",
    needsInput: "답변 대기",
    ended: "끝남",
    runningCount: (n: number) => `${n}개 실행 중`,
    scope: "사용량 범위",
    scopes: ["내 사용량", "워크스페이스"],
    view: "보기",
    cards: "카드",
    table: "표",
    agents: "에이전트 종류",
    kinds: [
      "전체",
      "내가 만든 것",
      "관리하는 것",
      "공유받은 것",
      "보관함",
      "초안",
      "실행 중",
    ],
  },
  ja: {
    status: "セッションの状態",
    all: "すべて",
    running: "実行中",
    needsInput: "回答待ち",
    ended: "終了",
    runningCount: (n: number) => `${n}件実行中`,
    scope: "使用量の範囲",
    scopes: ["自分の使用量", "ワークスペース"],
    view: "表示",
    cards: "カード",
    table: "表",
    agents: "エージェントの種類",
    kinds: [
      "すべて",
      "自分が作成",
      "管理中",
      "共有された",
      "アーカイブ",
      "下書き",
      "実行中",
    ],
  },
  en: {
    status: "Session status",
    all: "All",
    running: "Running",
    needsInput: "Waiting for reply",
    ended: "Ended",
    runningCount: (n: number) => `${n} running`,
    scope: "Usage scope",
    scopes: ["My usage", "Workspace"],
    view: "View",
    cards: "Cards",
    table: "Table",
    agents: "Agent kinds",
    kinds: [
      "All",
      "Created by me",
      "Administered",
      "Shared with me",
      "Archived",
      "Drafts",
      "Running",
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

// Demo counts; "ended" has none, so items with and without a count share a row.
const STATUSES = [
  { id: "all", key: "all", count: 128 },
  { id: "running", key: "running", count: 3 },
  { id: "needs_input", key: "needsInput", count: 0 },
  { id: "ended", key: "ended" },
] as const;

function StatusFilter({
  initial = "all",
  ...context
}: Globals & { readonly initial?: string }) {
  const copy = copyFor(context);
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      aria-label={copy.status}
      value={value}
      onValueChange={setValue}
    >
      {STATUSES.map((status) => (
        <SegmentedControlItem
          key={status.id}
          value={status.id}
          count={"count" in status ? status.count : undefined}
          countLabel={
            status.id === "running" ? copy.runningCount(3) : undefined
          }
        >
          {copy[status.key]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

function UsageScope(context: Globals) {
  const copy = copyFor(context);
  const [value, setValue] = useState("0");
  return (
    <SegmentedControl
      aria-label={copy.scope}
      value={value}
      onValueChange={setValue}
    >
      {copy.scopes.map((scope, index) => (
        <SegmentedControlItem key={scope} value={String(index)}>
          {scope}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/** The agents list's card/table switch: icon-only items named by aria-label. */
function ViewToggle(context: Globals) {
  const copy = copyFor(context);
  const [value, setValue] = useState("cards");
  return (
    <SegmentedControl
      aria-label={copy.view}
      value={value}
      onValueChange={setValue}
    >
      <SegmentedControlItem value="cards" aria-label={copy.cards}>
        <LayoutGrid aria-hidden="true" strokeWidth={1.5} />
      </SegmentedControlItem>
      <SegmentedControlItem value="table" aria-label={copy.table}>
        <Table2 aria-hidden="true" strokeWidth={1.5} />
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

function ManyItems(context: Globals) {
  const copy = copyFor(context);
  const [value, setValue] = useState("0");
  return (
    <SegmentedControl
      aria-label={copy.agents}
      value={value}
      onValueChange={setValue}
    >
      {copy.kinds.map((kind, index) => (
        <SegmentedControlItem
          key={kind}
          value={String(index)}
          count={index * 7}
        >
          {kind}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

const meta = {
  title: "Primitives/SegmentedControl",
  component: SegmentedControl,
  args: {
    "aria-label": COPY.ko.status,
    value: "all",
    onValueChange: () => undefined,
  },
  // Only the globals: the whole context would send the docs source snippet
  // into its circular references.
  render: (_args, { globals }) => <StatusFilter globals={globals} />,
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Session list status filter with counts; follows the toolbar's Language. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultJapanese: Story = {
  name: "Default (ja)",
  globals: { locale: "ja" },
};

export const DefaultEnglish: Story = {
  name: "Default (en)",
  globals: { locale: "en" },
};

/** The pressed item first, in the middle and last: the track's padding holds. */
export const PressedPositions: Story = {
  render: (_args, { globals }) => (
    <div className="flex flex-col items-start gap-4">
      <StatusFilter globals={globals} initial="all" />
      <StatusFilter globals={globals} initial="running" />
      <StatusFilter globals={globals} initial="ended" />
    </div>
  ),
};

/** Usage scope: no counts. */
export const WithoutCounts: Story = {
  render: (_args, { globals }) => <UsageScope globals={globals} />,
};

export const IconViewToggle: Story = {
  name: "Card/table view toggle",
  render: (_args, { globals }) => <ViewToggle globals={globals} />,
};

export const IconViewToggleDark: Story = {
  ...IconViewToggle,
  name: "Card/table view toggle (dark)",
  globals: { theme: "dark" },
};

/** More items than fit wrap inside the track; the page does not scroll. */
export const ManyItemsMobile: Story = {
  name: "Many items (390px)",
  render: (_args, { globals }) => <ManyItems globals={globals} />,
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const ManyItemsMobileDark: Story = {
  ...ManyItemsMobile,
  name: "Many items (390px, dark)",
  globals: {
    theme: "dark",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const Mobile: Story = {
  name: "Default (390px, en)",
  globals: {
    locale: "en",
    viewport: { value: "mobile390", isRotated: false },
  },
};
