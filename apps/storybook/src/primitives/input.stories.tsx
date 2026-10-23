import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
} from "@werft-ai/ui";

const DefaultField = () => (
  <Field>
    <FieldLabel>이메일</FieldLabel>
    <Input type="email" placeholder="name@example.com" />
    <FieldDescription>초대 링크를 이 주소로 보냅니다.</FieldDescription>
  </Field>
);

const DisabledField = () => (
  <Field>
    <FieldLabel>API key 이름</FieldLabel>
    <Input defaultValue="배포 스크립트" disabled={true} />
  </Field>
);

const InvalidField = () => (
  <Field>
    <FieldLabel>팀 이름</FieldLabel>
    <Input defaultValue="결제" />
    <FieldError>이미 있는 팀 이름입니다.</FieldError>
  </Field>
);

const meta = {
  title: "Primitives/Input",
  component: Input,
  decorators: [
    (Story) => (
      <div className="flex max-w-sm flex-col gap-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Input>;

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
