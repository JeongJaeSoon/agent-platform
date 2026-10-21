import type { Meta, StoryObj } from "@storybook/react-vite";
import { DestructiveActionDialog } from "@werft-ai/ui";
import { fn } from "storybook/test";

const meta = {
  title: "Patterns/DestructiveActionDialog",
  component: DestructiveActionDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
    title: "에이전트를 해고할까요?",
    consequence: "카드와 release가 비활성화되고, 진행 중인 세션은 종료됩니다.",
    resourceName: "결제 담당",
  },
} satisfies Meta<typeof DestructiveActionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const Mobile: Story = {
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
