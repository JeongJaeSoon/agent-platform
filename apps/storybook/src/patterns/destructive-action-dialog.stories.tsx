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
    title: "에이전트를 보관할까요?",
    consequence: "카드와 release가 비활성화되고, 진행 중인 세션은 종료됩니다.",
    resourceName: "결제 담당",
    confirmLabel: "보관",
  },
} satisfies Meta<typeof DestructiveActionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The confirm stays disabled until the resource name is typed. */
export const Default: Story = {};

export const Loading: Story = { args: { busy: true } };

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
