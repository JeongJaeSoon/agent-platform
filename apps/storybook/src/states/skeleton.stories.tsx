import { Skeleton } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "States/Skeleton",
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Lines: Story = { args: { lines: 3 } };

export const Circle: Story = { args: { shape: "circle" } };

export const Block: Story = { args: { shape: "block", height: "6rem" } };

export const LinesDark: Story = {
  ...Lines,
  name: "Lines (dark)",
  globals: { theme: "dark" },
};
