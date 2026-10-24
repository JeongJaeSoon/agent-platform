import type { Meta, StoryObj } from "@storybook/react-vite";
import { ListToolbar } from "@werft-ai/react/components";
import { SegmentedControl, SegmentedControlItem } from "@werft-ai/ui";
import { LayoutGrid, List } from "lucide-react";
import { useState } from "react";

import { MOBILE } from "../../screens/screen-kit.tsx";

function Scope() {
  const [scope, setScope] = useState("all");
  return (
    <SegmentedControl
      aria-label="보여 줄 에이전트"
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
  const [view, setView] = useState("cards");
  return (
    <SegmentedControl aria-label="보기" value={view} onValueChange={setView}>
      <SegmentedControlItem value="cards">
        <LayoutGrid aria-hidden="true" />
        카드
      </SegmentedControlItem>
      <SegmentedControlItem value="table">
        <List aria-hidden="true" />표
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

const meta = {
  title: "Domain/List/ListToolbar",
  component: ListToolbar,
  args: {
    filter: <Scope />,
    search: {
      type: "search",
      "aria-label": "이름이나 식별자로 찾기",
      placeholder: "이름이나 식별자로 찾기",
    },
    view: <View />,
  },
} satisfies Meta<typeof ListToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The agent list: categories, then search (260px), then cards or table. */
export const Default: Story = {};

/** A list with no view switch keeps the search alone on the right. */
export const SearchOnly: Story = { args: { view: undefined } };

/** At 390px the right group takes its own full-width row. */
export const Mobile: Story = { globals: MOBILE };

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};
