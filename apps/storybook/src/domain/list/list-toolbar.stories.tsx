import type { Meta, StoryObj } from "@storybook/react-vite";
import { ListToolbar, ListViewSwitch } from "@werft-ai/react/components";
import {
  FilterMenu,
  SegmentedControl,
  SegmentedControlItem,
} from "@werft-ai/ui";
import { LayoutGrid, List } from "lucide-react";
import { useState } from "react";

import { MOBILE } from "../../screens/screen-kit.tsx";

function Scope() {
  const [scope, setScope] = useState("all");
  return (
    <SegmentedControl
      aria-label="보여 줄 에이전트"
      size="toolbar"
      value={scope}
      onValueChange={setScope}
    >
      <SegmentedControlItem value="all" count={3}>
        전체
      </SegmentedControlItem>
      <SegmentedControlItem value="administered" count={2}>
        관리하는 에이전트
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

function View() {
  const [view, setView] = useState<"cards" | "table">("table");
  return (
    <ListViewSwitch
      aria-label="보기"
      value={view}
      onValueChange={setView}
      options={[
        { value: "cards", label: "카드", icon: LayoutGrid },
        { value: "table", label: "표", icon: List },
      ]}
    />
  );
}

const STATUSES = [
  ["all", "전체", 5],
  ["needs_input", "답변 대기", 1],
  ["running", "작업 중", 1],
  ["idle", "쉬는 중", 1],
  ["stopped", "멈춤", 1],
  ["failed", "실패", 1],
] as const;

function Status() {
  const [status, setStatus] = useState("all");
  return (
    <SegmentedControl
      aria-label="상태로 보기"
      size="toolbar"
      value={status}
      onValueChange={setStatus}
    >
      {STATUSES.map(([value, label, count]) => (
        <SegmentedControlItem key={value} value={value} count={count}>
          {label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

function Relation() {
  const [relation, setRelation] = useState("all");
  return (
    <FilterMenu
      label="관계"
      options={[
        { value: "all", label: "모든 관계" },
        { value: "started", label: "내가 시작" },
        { value: "shared", label: "공유받음" },
        { value: "administered", label: "관리하는 에이전트" },
      ]}
      value={relation}
      onValueChange={setRelation}
    />
  );
}

const meta = {
  title: "Domain/List/ListToolbar",
  component: ListToolbar,
  args: {
    filter: <Scope />,
    view: <View />,
    search: {
      type: "search",
      "aria-label": "이름이나 식별자로 찾기",
      placeholder: "이름이나 식별자로 찾기",
    },
  },
} satisfies Meta<typeof ListToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The agent list: categories, then cards or table, then search (260px). */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/** At 390px the right group takes its own row; the view switch is icons. */
export const Mobile: Story = { globals: MOBILE };

export const MobileDark: Story = {
  name: "Mobile (dark)",
  globals: { ...MOBILE, theme: "dark" },
};

/** The session list: status, then the relation chip, then search. */
export const Sessions: Story = {
  args: {
    filter: <Status />,
    filters: <Relation />,
    view: undefined,
    search: {
      type: "search",
      "aria-label": "제목이나 ID로 찾기",
      placeholder: "제목이나 ID로 찾기",
    },
  },
};

export const SessionsDark: Story = {
  ...Sessions,
  name: "Sessions (dark)",
  globals: { theme: "dark" },
};

/** Six statuses wrap inside their track; the chip and search share a row. */
export const SessionsMobile: Story = {
  ...Sessions,
  name: "Sessions (390px)",
  globals: MOBILE,
};

export const SessionsMobileDark: Story = {
  ...Sessions,
  name: "Sessions (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

/** A list with no view switch keeps the search alone on the right. */
export const SearchOnly: Story = { args: { view: undefined } };
