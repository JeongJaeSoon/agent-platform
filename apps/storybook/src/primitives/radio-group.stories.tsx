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

function ShareScope({ disabled = false }: { readonly disabled?: boolean }) {
  const legendId = useId();
  return (
    <FieldSet className="max-w-md">
      <FieldLegend id={legendId} variant="label">
        공유 범위
      </FieldLegend>
      <RadioGroup
        name="share"
        defaultValue="team"
        disabled={disabled}
        aria-labelledby={legendId}
      >
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
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One option is off on its own; the rest can be picked. */
export const Default: Story = { render: () => <ShareScope /> };

export const Disabled: Story = { render: () => <ShareScope disabled={true} /> };

export const DefaultDark: Story = {
  ...Default,
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  ...Default,
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
