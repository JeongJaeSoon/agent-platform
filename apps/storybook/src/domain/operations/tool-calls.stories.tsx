import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolCalls, ToolsSummary } from "@werft-ai/react/components";

import { BASH_CALLS, TOOLS } from "./operations-fixtures.ts";

/**
 * One tool's latest calls (GET /v1/usage/tools/{name}/calls). A session the
 * viewer cannot read has no title and no link; an outcome not read is
 * "결과 모름", never success.
 */
const meta = {
  title: "Domain/Operations/ToolCalls",
  component: ToolCalls,
  args: { calls: BASH_CALLS, timeZone: "Asia/Seoul" },
  render: (args) => (
    <div className="max-w-[336px]">
      <ToolCalls {...args} />
    </div>
  ),
} satisfies Meta<typeof ToolCalls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { calls: [] } };

export const Dark: Story = { globals: { theme: "dark" } };

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

/** The tools tab's lead sentence over the same response's `tools`. */
export const Summary: Story = {
  render: () => <ToolsSummary tools={TOOLS.tools} period="최근 30일" />,
};

export const SummaryEnglish: Story = {
  name: "Summary (en)",
  render: () => <ToolsSummary tools={TOOLS.tools} period="last 30 days" />,
  globals: { locale: "en" },
};
