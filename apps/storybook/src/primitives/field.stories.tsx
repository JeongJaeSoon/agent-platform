import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Textarea,
} from "@werft-ai/ui";

const meta = {
  title: "Primitives/Field",
  component: Field,
  decorators: [
    (Story) => (
      <form className="max-w-md" onSubmit={(event) => event.preventDefault()}>
        <Story />
      </form>
    ),
  ],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <FieldGroup>
      <Field>
        <FieldLabel>에이전트 이름</FieldLabel>
        <Input name="name" defaultValue="결제 담당" />
        <FieldDescription>팀 안에서 겹치지 않아야 합니다.</FieldDescription>
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
  ),
};

/** A disabled fieldset turns off every control inside it. */
export const Disabled: Story = {
  render: () => (
    <FieldSet disabled={true}>
      <FieldLegend>보관된 에이전트</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel>에이전트 이름</FieldLabel>
          <Input name="name" defaultValue="결제 담당" />
        </Field>
        <Field orientation="horizontal">
          <Button type="submit">저장</Button>
        </Field>
      </FieldGroup>
    </FieldSet>
  ),
};

/** A mounted FieldError marks its control invalid and describes it. */
export const Invalid: Story = {
  render: () => (
    <FieldGroup>
      <Field>
        <FieldLabel>팀 이름</FieldLabel>
        <Input name="team" defaultValue="결제" />
        <FieldError>이미 있는 팀 이름입니다.</FieldError>
      </Field>
      <Field orientation="horizontal">
        <Button type="submit">만들기</Button>
      </Field>
    </FieldGroup>
  ),
};

export const InvalidDark: Story = {
  ...Invalid,
  name: "Invalid (dark)",
  globals: { theme: "dark" },
};

export const InvalidMobile: Story = {
  ...Invalid,
  name: "Invalid (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
