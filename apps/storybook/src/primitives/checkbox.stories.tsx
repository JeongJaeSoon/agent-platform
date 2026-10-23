import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@werft-ai/ui";

const DefaultFields = () => (
  <>
    <Field orientation="horizontal">
      <Checkbox defaultChecked={true} />
      <FieldLabel>승인 요청이 오면 알립니다</FieldLabel>
    </Field>
    <Field orientation="horizontal">
      <Checkbox />
      <FieldContent>
        <FieldLabel>세션이 끝나면 알립니다</FieldLabel>
        <FieldDescription>오래 걸리는 세션에 쓸모가 있습니다.</FieldDescription>
      </FieldContent>
    </Field>
  </>
);

const DisabledField = () => (
  <Field orientation="horizontal">
    <Checkbox disabled={true} />
    <FieldLabel>Slack으로도 보냅니다</FieldLabel>
  </Field>
);

const InvalidField = () => (
  <Field orientation="horizontal">
    <Checkbox />
    <FieldContent>
      <FieldLabel>보관하면 세션이 종료됨을 확인했습니다</FieldLabel>
      <FieldError>확인해야 보관할 수 있습니다.</FieldError>
    </FieldContent>
  </Field>
);

const meta = {
  title: "Primitives/Checkbox",
  component: Checkbox,
  decorators: [
    (Story) => (
      <FieldSet className="max-w-md">
        <FieldLegend variant="label">알림</FieldLegend>
        <Story />
      </FieldSet>
    ),
  ],
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <DefaultFields /> };

export const Disabled: Story = { render: () => <DisabledField /> };

export const Invalid: Story = { render: () => <InvalidField /> };

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: () => (
    <>
      <DefaultFields />
      <DisabledField />
      <InvalidField />
    </>
  ),
};

export const StatesDark: Story = {
  ...States,
  name: "States (dark)",
  globals: { theme: "dark" },
};

export const StatesMobile: Story = {
  ...States,
  name: "States (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
