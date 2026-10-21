import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
} from "@werft-ai/ui";

const meta = {
  title: "Primitives/Input",
  component: Input,
  render: () => (
    <div className="flex max-w-sm flex-col gap-6">
      <Field>
        <FieldLabel>이메일</FieldLabel>
        <Input type="email" placeholder="name@example.com" />
        <FieldDescription>초대 링크를 이 주소로 보냅니다.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>API key 이름</FieldLabel>
        <Input defaultValue="배포 스크립트" disabled={true} />
      </Field>
      <Field>
        <FieldLabel>팀 이름</FieldLabel>
        <Input defaultValue="결제" />
        <FieldError>이미 있는 팀 이름입니다.</FieldError>
      </Field>
    </div>
  ),
} satisfies Meta<typeof Input>;

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
