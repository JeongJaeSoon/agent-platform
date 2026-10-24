import type { Meta, StoryObj } from "@storybook/react-vite";
import { Findings } from "@werft-ai/react/components";

import { TOOLS } from "./operations-fixtures.ts";

/**
 * "What to look at": GET /v1/usage/tools `findings`, each read against the
 * same-named row of `tools`.
 */
const meta = {
  title: "Domain/Operations/Findings",
  component: Findings,
  args: { data: TOOLS },
  render: (args) => (
    <div className="max-w-[752px]">
      <Findings {...args} />
    </div>
  ),
} satisfies Meta<typeof Findings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Three: Story = {};

export const None: Story = { args: { data: { ...TOOLS, findings: [] } } };

export const Dark: Story = { globals: { theme: "dark" } };

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };
