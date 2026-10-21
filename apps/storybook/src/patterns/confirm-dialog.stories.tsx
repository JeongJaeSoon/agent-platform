import { ConfirmDialog } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

const meta = {
  title: "Patterns/ConfirmDialog",
  component: ConfirmDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
    title: "세션을 일시정지할까요?",
    consequence: "실행 중인 턴은 마무리하고, 대기 중인 지시는 그대로 남습니다.",
    confirmLabel: "일시정지",
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Busy: Story = { args: { busy: true } };

export const Danger: Story = {
  args: {
    tone: "danger",
    title: "세션을 종료할까요?",
    consequence: "종료한 세션은 다시 열 수 없습니다.",
    confirmLabel: "종료",
  },
};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const Mobile: Story = {
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
