import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field, FieldDescription, FieldLabel, Textarea } from "@werft-ai/ui";

const meta = {
  title: "Primitives/Textarea",
  component: Textarea,
  render: () => (
    <div className="flex max-w-md flex-col gap-6">
      <Field>
        <FieldLabel>지시문</FieldLabel>
        <Textarea placeholder="에이전트가 할 일을 적습니다" />
        <FieldDescription>입력하는 만큼 칸이 늘어납니다.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>보관된 메모</FieldLabel>
        <Textarea defaultValue="수정할 수 없는 메모" disabled={true} />
      </Field>
    </div>
  ),
} satisfies Meta<typeof Textarea>;

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
