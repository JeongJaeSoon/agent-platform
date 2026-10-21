import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Textarea,
} from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Primitives/Field",
  component: Field,
  render: () => (
    <form className="max-w-md" onSubmit={(event) => event.preventDefault()}>
      <FieldGroup>
        <Field>
          <FieldLabel>에이전트 이름</FieldLabel>
          <Input name="name" defaultValue="결제 담당" />
          <FieldDescription>팀 안에서 겹치지 않아야 합니다.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>팀 이름</FieldLabel>
          <Input name="team" defaultValue="결제" />
          <FieldError>이미 있는 팀 이름입니다.</FieldError>
        </Field>
        <Field>
          <FieldLabel>지시문</FieldLabel>
          <Textarea
            name="instructions"
            placeholder="에이전트가 할 일을 적습니다"
          />
        </Field>
        <Field orientation="horizontal">
          <Button type="submit">만들기</Button>
        </Field>
      </FieldGroup>
    </form>
  ),
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {};

export const FormDark: Story = {
  name: "Form (dark)",
  globals: { theme: "dark" },
};

export const FormMobile: Story = {
  name: "Form (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
