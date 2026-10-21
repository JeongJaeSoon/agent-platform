import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, EmptyState } from "@werft-ai/ui";

const meta = {
  title: "States/EmptyState",
  component: EmptyState,
  args: {
    title: "아직 세션이 없습니다",
    description: "에이전트에게 첫 지시를 보내면 여기에 쌓입니다.",
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = { args: { description: undefined } };

export const WithActions: Story = {
  args: {
    action: <Button type="button">새 세션</Button>,
    secondaryAction: (
      <Button type="button" variant="ghost">
        에이전트 보기
      </Button>
    ),
  },
};

export const WithActionsDark: Story = {
  ...WithActions,
  name: "With actions (dark)",
  globals: { theme: "dark" },
};
