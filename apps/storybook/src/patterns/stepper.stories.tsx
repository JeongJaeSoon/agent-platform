import type { Meta, StoryObj } from "@storybook/react-vite";
import { Stepper, type StepperStep } from "@werft-ai/ui";
import { useState } from "react";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    label: "에이전트 만들기 단계",
    completed: "완료",
    steps: ["이름", "하는 일", "배포 판", "켜기"],
    slack: "Slack 연결",
    optional: "선택",
  },
  ja: {
    label: "エージェント作成のステップ",
    completed: "完了",
    steps: ["名前", "役割", "リリース", "有効化"],
    slack: "Slack 連携",
    optional: "任意",
  },
  en: {
    label: "Steps to make an agent",
    completed: "completed",
    steps: ["Name", "What it does", "Release", "Turn on"],
    slack: "Connect Slack",
    optional: "Optional",
  },
} as const;

const IDS = ["name", "job", "release", "activate"] as const;

type Locale = keyof typeof COPY;
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  const locale: Locale =
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko";
  return COPY[locale];
}

function wizardSteps(context: Globals, withSlack = false): StepperStep[] {
  const copy = copyFor(context);
  const steps: StepperStep[] = IDS.map((id, index) => ({
    id,
    label: copy.steps[index],
  }));
  return withSlack
    ? [...steps, { id: "slack", label: copy.slack, status: copy.optional }]
    : steps;
}

const meta = {
  title: "Patterns/Stepper",
  component: Stepper,
  args: { label: COPY.ko.label, steps: [], currentStepId: "job" },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <Stepper
        {...args}
        label={copy.label}
        completedLabel={copy.completed}
        steps={wizardSteps(context)}
      />
    );
  },
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The four-step agent wizard on its second step; follows the toolbar's Language. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const FirstStep: Story = { args: { currentStepId: "name" } };

/** Every step before the last is finished. */
export const LastStep: Story = { args: { currentStepId: "activate" } };

/** A fifth step the screen marks optional with `status`. */
export const OptionalStep: Story = {
  args: { currentStepId: "slack" },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <Stepper
        {...args}
        label={copy.label}
        completedLabel={copy.completed}
        steps={wizardSteps(context, true)}
      />
    );
  },
};

export const OptionalStepDark: Story = {
  ...OptionalStep,
  name: "Optional step (dark)",
  globals: { theme: "dark" },
};

export const OptionalStepMobile: Story = {
  ...OptionalStep,
  name: "Optional step (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const OptionalStepEarly: Story = {
  ...OptionalStep,
  name: "Optional step (on step 2)",
  args: { currentStepId: "job" },
};

export const OptionalStepEarlyMobile: Story = {
  ...OptionalStepEarly,
  name: "Optional step (on step 2, 390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

/** A step's description sits under its name; such a step is taller than 44px. */
export const WithDescription: Story = {
  render: (args, context) => (
    <Stepper
      {...args}
      label={copyFor(context).label}
      steps={wizardSteps(context).map((step) =>
        step.id === "job" ? { ...step, description: "역할과 지시문" } : step,
      )}
    />
  ),
};

export const Japanese: Story = { globals: { locale: "ja" } };

export const JapaneseDark: Story = {
  name: "Japanese (dark)",
  globals: { locale: "ja", theme: "dark" },
};

export const English: Story = { globals: { locale: "en" } };

export const EnglishDark: Story = {
  name: "English (dark)",
  globals: { locale: "en", theme: "dark" },
};

export const Mobile: Story = {
  name: "Mobile (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const MobileDark: Story = {
  name: "Mobile (390px, dark)",
  globals: {
    theme: "dark",
    viewport: { value: "mobile390", isRotated: false },
  },
};

/** Later steps stay disabled until the screen says they can be reached. */
export const Interactive: Story = {
  render: (args, context) => {
    const steps = wizardSteps(context);
    const [current, setCurrent] = useState(args.currentStepId);
    const at = steps.findIndex((step) => step.id === current);
    const copy = copyFor(context);
    return (
      <Stepper
        {...args}
        label={copy.label}
        completedLabel={copy.completed}
        steps={steps.map((step, index) => ({
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
