import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
} from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Primitives/RadioGroup",
  component: RadioGroup,
  render: () => (
    <FieldSet className="max-w-md">
      <FieldLegend variant="label">공유 범위</FieldLegend>
      <RadioGroup name="share" defaultValue="team">
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
  ),
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
