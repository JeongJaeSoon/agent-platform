import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Textarea,
} from "@werft-ai/ui";

const DefaultField = () => (
  <Field>
    <FieldLabel>지시문</FieldLabel>
    <Textarea placeholder="에이전트가 할 일을 적습니다" />
    <FieldDescription>입력하는 만큼 칸이 늘어납니다.</FieldDescription>
  </Field>
);

const DisabledField = () => (
  <Field>
    <FieldLabel>보관된 메모</FieldLabel>
    <Textarea defaultValue="수정할 수 없는 메모" disabled={true} />
  </Field>
);

const InvalidField = () => (
  <Field>
    <FieldLabel>거절 사유</FieldLabel>
    <Textarea defaultValue="" />
    <FieldError>거절 사유를 적어야 합니다.</FieldError>
  </Field>
);

const meta = {
  title: "Primitives/Textarea",
  component: Textarea,
  decorators: [
    (Story) => (
      <div className="flex max-w-md flex-col gap-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <DefaultField /> };

export const Disabled: Story = { render: () => <DisabledField /> };

export const Invalid: Story = { render: () => <InvalidField /> };

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: () => (
    <>
      <DefaultField />
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
