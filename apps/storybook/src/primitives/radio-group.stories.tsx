import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
} from "@werft-ai/ui";
import { useId } from "react";

function ShareScope() {
  const legendId = useId();
  return (
    <FieldSet className="max-w-md">
      <FieldLegend id={legendId} variant="label">
        공유 범위
      </FieldLegend>
      <RadioGroup name="share" defaultValue="team" aria-labelledby={legendId}>
        <Field orientation="horizontal">
          <RadioGroupItem value="private" />
          <FieldLabel>나만</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem value="team" />
          <FieldContent>
            <FieldLabel>팀</FieldLabel>
            <FieldDescription>같은 팀 멤버가 세션을 봅니다.</FieldDescription>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem value="org" disabled={true} />
          <FieldLabel>조직 전체</FieldLabel>
        </Field>
      </RadioGroup>
    </FieldSet>
  );
}

const meta = {
  title: "Primitives/RadioGroup",
  component: RadioGroup,
  render: () => <ShareScope />,
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {};

export const StatesDark: Story = {
  name: "States (dark)",
  globals: { theme: "dark" },
};

export const StatesMobile: Story = {
  name: "States (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
