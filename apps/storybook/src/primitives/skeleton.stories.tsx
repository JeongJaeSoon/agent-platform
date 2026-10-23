import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton } from "@werft-ai/ui";

/** Skeleton is the Loading state other components show in their place. */
const meta = {
  title: "Primitives/Skeleton",
  component: Skeleton,
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { lines: 3 } };

export const Circle: Story = { args: { shape: "circle" } };

export const Block: Story = { args: { shape: "block", height: "6rem" } };

export const DefaultDark: Story = {
  ...Default,
  name: "Default (dark)",
  globals: { theme: "dark" },
};
