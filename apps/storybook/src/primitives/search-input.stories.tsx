import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  NativeSelect,
  NativeSelectOption,
  SearchInput,
  SegmentedControl,
  SegmentedControlItem,
} from "@werft-ai/ui";
import { useState } from "react";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    search: "세션 검색",
    status: "세션 상태",
    all: "전체",
    running: "실행 중",
    relation: "관계",
    relations: ["모두", "내가 시작", "공유받음"],
  },
  ja: {
    search: "セッションを検索",
    status: "セッションの状態",
    all: "すべて",
    running: "実行中",
    relation: "関係",
    relations: ["すべて", "自分が開始", "共有された"],
  },
  en: {
    search: "Search sessions",
    status: "Session status",
    all: "All",
    running: "Running",
    relation: "Relation",
    relations: ["Everyone", "Started by me", "Shared with me"],
  },
} as const;

type Locale = keyof typeof COPY;
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  const locale: Locale =
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko";
  return COPY[locale];
}

function Search(context: Globals) {
  const copy = copyFor(context);
  return <SearchInput aria-label={copy.search} placeholder={copy.search} />;
}

/**
 * The session list's v4 toolbar row: filter, search, relation select. The row
 * itself (gap 8, wrap) is the screen's; it is drawn here only to show the
 * search field's flex sizing beside its neighbours.
 */
function Toolbar(context: Globals) {
  const copy = copyFor(context);
  const [status, setStatus] = useState("all");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        aria-label={copy.status}
        value={status}
        onValueChange={setStatus}
      >
        <SegmentedControlItem value="all" count={128}>
          {copy.all}
        </SegmentedControlItem>
        <SegmentedControlItem value="running" count={3}>
          {copy.running}
        </SegmentedControlItem>
      </SegmentedControl>
      <SearchInput aria-label={copy.search} placeholder={copy.search} />
      <NativeSelect aria-label={copy.relation}>
        {copy.relations.map((relation) => (
          <NativeSelectOption key={relation} value={relation}>
            {relation}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

const meta = {
  title: "Primitives/SearchInput",
  component: SearchInput,
  args: { "aria-label": COPY.ko.search },
  render: (_args, { globals }) => <Search globals={globals} />,
} satisfies Meta<typeof SearchInput>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Alone, the field fills its parent up to 320px. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const InToolbar: Story = {
  name: "In a toolbar",
  render: (_args, { globals }) => <Toolbar globals={globals} />,
};

export const InToolbarDark: Story = {
  ...InToolbar,
  name: "In a toolbar (dark)",
  globals: { theme: "dark" },
};

export const InToolbarMobile: Story = {
  ...InToolbar,
  name: "In a toolbar (390px, ja)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
