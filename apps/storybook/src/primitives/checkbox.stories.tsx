import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@werft-ai/ui";

const meta = {
  title: "Primitives/Checkbox",
  component: Checkbox,
  render: () => (
    <FieldSet className="max-w-md">
      <FieldLegend variant="label">알림</FieldLegend>
      <Field orientation="horizontal">
        <Checkbox defaultChecked={true} />
        <FieldLabel>승인 요청이 오면 알립니다</FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox />
        <FieldContent>
          <FieldLabel>세션이 끝나면 알립니다</FieldLabel>
          <FieldDescription>
            오래 걸리는 세션에 쓸모가 있습니다.
          </FieldDescription>
        </FieldContent>
      </Field>
      <Field orientation="horizontal">
        <Checkbox disabled={true} />
        <FieldLabel>Slack으로도 보냅니다</FieldLabel>
      </Field>
    </FieldSet>
  ),
} satisfies Meta<typeof Checkbox>;

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
