import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sparkline } from "@werft-ai/ui";

// Thirty days of session counts, weekends lower.
const DAYS = Array.from({ length: 30 }, (_, i) =>
  Math.max(
    2,
    Math.round(
      13 +
        5 * Math.sin(i / 2.6) +
        (i % 7 === 5 || i % 7 === 6 ? -8 : 0) +
        i * 0.15,
    ),
  ),
);

/** The trend under a StatCard's figure; it has no axes of its own. */
const meta = {
  title: "Primitives/Sparkline",
  component: Sparkline,
  args: { values: DAYS, label: "일자별 세션 수" },
  render: (args) => (
    <div className="max-w-[320px]">
      <Sparkline {...args} />
    </div>
  ),
} satisfies Meta<typeof Sparkline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Flat: Story = { args: { values: [4, 4, 4, 4, 4, 4, 4] } };

export const SinglePoint: Story = { args: { values: [12] } };

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};
