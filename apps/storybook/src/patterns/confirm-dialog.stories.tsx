import type { Meta, StoryObj } from "@storybook/react-vite";
import { Combobox, ConfirmDialog, Field, FieldLabel } from "@werft-ai/ui";
import { useState } from "react";
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

/** The confirm is on its way; both buttons wait. */
export const Loading: Story = { args: { busy: true } };

export const Danger: Story = {
  args: {
    tone: "danger",
    title: "세션을 종료할까요?",
    consequence: "종료한 세션은 다시 열 수 없습니다.",
    confirmLabel: "종료",
  },
};

/** Interrupts a running flow, so screen readers announce it as an alert. */
export const AlertDialog: Story = {
  args: {
    ...Danger.args,
    role: "alertdialog",
  },
};

const CHANNELS = ["#general", "#random", "#dev-platform"];

function PickFirstDialog(args: Story["args"]) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <ConfirmDialog
      {...meta.args}
      {...args}
      title="채널 추가"
      consequence="공개 채널은 고르면 봇이 바로 참여합니다."
      confirmLabel="추가"
      confirmDisabled={picked === null}
    >
      <Field>
        <FieldLabel>채널</FieldLabel>
        <Combobox
          options={CHANNELS.map((name) => ({ value: name, label: name }))}
          value={picked}
          onValueChange={setPicked}
          emptyMessage="맞는 채널이 없습니다."
          placeholder="채널 이름으로 검색"
        />
      </Field>
    </ConfirmDialog>
  );
}

/** Confirm waits until a control in the body has a value. */
export const PickFirst: Story = {
  render: (args) => <PickFirstDialog {...args} />,
};

export const PickFirstMobile: Story = {
  ...PickFirst,
  name: "Pick first (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
