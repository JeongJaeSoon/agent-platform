import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton, Text } from "@werft-ai/ui";

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

/** One value on a line of text, hidden when the screen says it once. */
export const InlineDecorative: Story = {
  args: { inline: true, decorative: true, width: "2rem", height: "1lh" },
  render: (args) => (
    <Text>
      slot <Skeleton {...args} className="justify-center" /> / 10
    </Text>
  ),
};

export const DefaultDark: Story = {
  ...Default,
  name: "Default (dark)",
  globals: { theme: "dark" },
};
