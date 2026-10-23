import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stepper, type StepperStep } from "@werft-ai/ui";
import { useState } from "react";

const STEPS: StepperStep[] = [
  { id: "basics", label: "기본 정보", description: "이름과 설명" },
  { id: "model", label: "모델", description: "답할 모델" },
  { id: "tools", label: "도구", description: "쓸 수 있는 도구" },
  { id: "review", label: "검토", description: "만들기 전 확인" },
];

const meta = {
  title: "Patterns/Stepper",
  component: Stepper,
  args: { label: "에이전트 만들기 단계", steps: STEPS, currentStepId: "model" },
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Later steps stay disabled until the screen says they can be reached. */
export const Interactive: Story = {
  render: (args) => {
    const [current, setCurrent] = useState(args.currentStepId);
    const at = STEPS.findIndex((step) => step.id === current);
    return (
      <Stepper
        {...args}
        steps={STEPS.map((step, index) => ({
          ...step,
          disabled: index > at + 1,
        }))}
        currentStepId={current}
        onStepSelect={setCurrent}
      />
    );
  },
};

export const InteractiveDark: Story = {
  ...Interactive,
  name: "Interactive (dark)",
  globals: { theme: "dark" },
};

export const InteractiveMobile: Story = {
  ...Interactive,
  name: "Interactive (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
