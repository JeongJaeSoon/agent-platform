import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, EmptyState } from "@werft-ai/ui";
import { Inbox } from "lucide-react";

const meta = {
  title: "Patterns/EmptyState",
  component: EmptyState,
  args: {
    title: "아직 세션이 없습니다",
    description: "에이전트에게 첫 지시를 보내면 여기에 쌓입니다.",
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

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

/** Console v4 `.empty-ic`: a 40px quiet box above the title. */
export const WithIcon: Story = {
  args: {
    icon: <Inbox size={16} strokeWidth={1.5} />,
    action: (
      <Button type="button" size="sm">
        새 세션
      </Button>
    ),
  },
};

/** `size="sm"` inside a flush card, as the home's waiting list (v4 L528). */
export const SmallInCard: Story = {
  args: { icon: <Inbox size={16} strokeWidth={1.5} />, size: "sm" },
  decorators: [
    (Story) => (
      <div className="rounded-card border bg-card">
        <Story />
      </div>
    ),
  ],
};

export const SmallInCardDark: Story = {
  ...SmallInCard,
  name: "Small in card (dark)",
  globals: { theme: "dark" },
};

export const SmallInCardMobile: Story = {
  ...SmallInCard,
  name: "Small in card (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
