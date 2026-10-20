import { Button } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Primitives/Button",
  component: Button,
  args: { type: "button", children: "기본" },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "outline",
        "secondary",
        "ghost",
        "destructive",
        "link",
      ],
    },
    size: { control: "select", options: ["default", "sm", "lg", "icon"] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="story-row">
      <Button type="button">기본</Button>
      <Button type="button" variant="outline">
        테두리
      </Button>
      <Button type="button" variant="secondary">
        보조
      </Button>
      <Button type="button" variant="ghost">
        조용히
      </Button>
      <Button type="button" variant="destructive">
        삭제
      </Button>
      <Button type="button" variant="link">
        링크
      </Button>
      <Button type="button" size="sm">
        작게
      </Button>
      <Button type="button" disabled={true}>
        잠김
      </Button>
      <Button asChild={true} variant="outline">
        <a href="/agents">링크를 버튼처럼</a>
      </Button>
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};
