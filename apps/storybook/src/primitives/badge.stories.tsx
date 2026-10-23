import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@werft-ai/ui";

const meta = {
  title: "Primitives/Badge",
  component: Badge,
  args: { children: "기본" },
  argTypes: {
    variant: {
      control: "select",
      options: ["gray", "blue", "green", "amber", "red"],
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Console v35's five badge tones. */
export const Tones: Story = {
  render: () => (
    <div className="story-row">
      <Badge variant="gray">초안</Badge>
      <Badge variant="blue">진행 중</Badge>
      <Badge variant="green">연결됨</Badge>
      <Badge variant="amber">확인 필요</Badge>
      <Badge variant="red">실패</Badge>
    </div>
  ),
};

export const TonesDark: Story = {
  ...Tones,
  name: "Tones (dark)",
  globals: { theme: "dark" },
};
