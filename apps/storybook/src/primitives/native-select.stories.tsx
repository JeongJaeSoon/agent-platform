import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@werft-ai/ui";

const meta = {
  title: "Primitives/NativeSelect",
  component: NativeSelect,
  render: () => (
    <div className="flex max-w-sm flex-col gap-6">
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
      <Field>
        <FieldLabel>실행 위치</FieldLabel>
        <NativeSelect disabled={true}>
          <NativeSelectOption>로컬</NativeSelectOption>
        </NativeSelect>
      </Field>
    </div>
  ),
} satisfies Meta<typeof NativeSelect>;

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
