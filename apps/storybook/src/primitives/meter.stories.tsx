import type { Meta, StoryObj } from "@storybook/react-vite";
import { Meter } from "@werft-ai/ui";

/**
 * A share of a whole: the operations menu's slot use (8px) and the 4px bar
 * under a table cell. The figure is always also written beside it.
 */
const meta = {
  title: "Primitives/Meter",
  component: Meter,
  args: { value: 7, max: 10, label: "동시 실행 slot 사용률" },
  render: (args) => (
    <div className="max-w-[480px]">
      <Meter {...args} />
    </div>
  ),
} satisfies Meta<typeof Meter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Inline: Story = {
  args: { value: 445.28, max: 445.28 * 1.6, size: "inline" },
};

export const Caution: Story = { args: { value: 9, tone: "caution" } };

/** A value past `max` stops at a full bar. */
export const Full: Story = { args: { value: 12 } };

export const Zero: Story = { args: { value: 0 } };

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const InlineDark: Story = {
  ...Inline,
  name: "Inline (dark)",
  globals: { theme: "dark" },
};

export const Mobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
