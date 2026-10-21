import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@werft-ai/ui";

const meta = {
  title: "Primitives/Badge",
  component: Badge,
  args: { children: "기본" },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "secondary", "destructive", "outline"],
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="story-row">
      <Badge>기본</Badge>
      <Badge variant="secondary">보조</Badge>
      <Badge variant="destructive">위험</Badge>
      <Badge variant="outline">테두리</Badge>
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};
