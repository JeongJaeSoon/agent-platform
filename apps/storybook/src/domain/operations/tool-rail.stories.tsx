import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolRail } from "@werft-ai/react/components";
import { fn } from "storybook/test";

import { toolDetail } from "../../screens/operations-fixtures.ts";
import { MOBILE } from "../../screens/screen-kit.tsx";
import { TOOLS } from "./operations-fixtures.ts";

/**
 * The selected tool on the operations tools tab: its GET /v1/usage/tools
 * row, then GET /v1/usage/tools/{name}/calls per day and latest calls.
 */
const BASH = TOOLS.tools[0];
if (!BASH) throw new Error("TOOLS has no tool");
const DETAIL = toolDetail(BASH);

const meta = {
  title: "Domain/Operations/ToolRail",
  component: ToolRail,
  decorators: [
    (Story) => (
      <div className="max-w-[25rem]">
        <Story />
      </div>
    ),
  ],
  args: {
    name: BASH.name,
    tool: BASH,
    note: "셸 명령",
    perDay: DETAIL.perDay,
    calls: DETAIL.calls,
    callSort: "recent",
    onCallSortChange: fn(),
    timeZone: "Asia/Seoul",
  },
} satisfies Meta<typeof ToolRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The API's slowest order: longest first, unmeasured calls last. */
export const Slowest: Story = {
  args: {
    callSort: "slowest",
    calls: [...DETAIL.calls].sort(
      (a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1),
    ),
  },
};

/** The tool is picked and its calls are read: each part keeps its place. */
export const Loading: Story = {
  args: { perDay: undefined, calls: undefined },
};

/** The calls could not be read: the error stands in for chart and list. */
export const ReadFailed: Story = {
  args: { error: "호출 기록을 읽지 못했습니다." },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };
