import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@werft-ai/ui";

const DefaultField = () => (
  <>
    <Field>
      <FieldLabel>역할</FieldLabel>
      <NativeSelect defaultValue="member">
        <NativeSelectOption value="admin">관리자</NativeSelectOption>
        <NativeSelectOption value="member">멤버</NativeSelectOption>
      </NativeSelect>
      <FieldDescription>
        휴대폰에서는 기기의 선택 창이 열립니다.
      </FieldDescription>
    </Field>
    <Field>
      <FieldLabel>모델</FieldLabel>
      <NativeSelect size="sm" defaultValue="fast">
        <NativeSelectOptGroup label="일반">
          <NativeSelectOption value="fast">빠른 모델</NativeSelectOption>
        </NativeSelectOptGroup>
        <NativeSelectOptGroup label="고급">
          <NativeSelectOption value="deep">깊은 모델</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>
    </Field>
  </>
);

const DisabledField = () => (
  <Field>
    <FieldLabel>실행 위치</FieldLabel>
    <NativeSelect disabled={true}>
      <NativeSelectOption>로컬</NativeSelectOption>
    </NativeSelect>
  </Field>
);

const InvalidField = () => (
  <Field>
    <FieldLabel>담당 팀</FieldLabel>
    <NativeSelect defaultValue="">
      <NativeSelectOption value="">팀을 고르세요</NativeSelectOption>
      <NativeSelectOption value="billing">결제</NativeSelectOption>
    </NativeSelect>
    <FieldError>팀을 골라야 합니다.</FieldError>
  </Field>
);

const meta = {
  title: "Primitives/NativeSelect",
  component: NativeSelect,
  decorators: [
    (Story) => (
      <div className="flex max-w-sm flex-col gap-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NativeSelect>;

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
