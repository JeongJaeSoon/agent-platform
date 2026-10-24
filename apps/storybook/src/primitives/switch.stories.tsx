import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  Switch,
} from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    label: "게스트 허용",
    description: "Slack 게스트 계정도 에이전트를 부를 수 있습니다.",
    off: "꺼짐",
    on: "켜짐",
    disabledOff: "비활성(꺼짐)",
    disabledOn: "비활성(켜짐)",
    busy: "저장 중(켜짐)",
  },
  ja: {
    label: "ゲストを許可",
    description: "Slack のゲストアカウントもエージェントを呼び出せます。",
    off: "オフ",
    on: "オン",
    disabledOff: "無効(オフ)",
    disabledOn: "無効(オン)",
    busy: "保存中(オン)",
  },
  en: {
    label: "Allow guests",
    description: "Slack guest accounts can call the agent too.",
    off: "Off",
    on: "On",
    disabledOff: "Disabled (off)",
    disabledOn: "Disabled (on)",
    busy: "Saving (on)",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

const meta = {
  title: "Primitives/Switch",
  component: Switch,
  args: { "aria-label": COPY.ko.label },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {};

export const On: Story = { args: { defaultChecked: true } };

export const DisabledOff: Story = { args: { disabled: true } };

export const DisabledOn: Story = {
  args: { disabled: true, defaultChecked: true },
};

/** While saving: full colour with a spinner in the thumb; keeps focus and refuses the toggle. */
export const Busy: Story = {
  args: { "aria-disabled": true, defaultChecked: true },
};

/** Inside a Field the label names the switch and the description describes it. */
export const InField: Story = {
  render: (_args, context) => {
    const copy = copyFor(context);
    return (
      <Field orientation="horizontal" className="max-w-md">
        <Switch />
        <FieldContent>
          <FieldLabel>{copy.label}</FieldLabel>
          <FieldDescription>{copy.description}</FieldDescription>
        </FieldContent>
      </Field>
    );
  },
};

export const InFieldJapanese: Story = {
  ...InField,
  name: "In field (ja)",
  globals: { locale: "ja" },
};

export const InFieldEnglish: Story = {
  ...InField,
  name: "In field (en)",
  globals: { locale: "en" },
};

/** Every state in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (_args, context) => {
    const copy = copyFor(context);
    const states = [
      [copy.off, {}],
      [copy.on, { defaultChecked: true }],
      [copy.disabledOff, { disabled: true }],
      [copy.disabledOn, { disabled: true, defaultChecked: true }],
      [copy.busy, { "aria-disabled": true, defaultChecked: true }],
    ] as const;
    return (
      <div className="flex flex-col gap-4">
        {states.map(([label, props]) => (
          <Field key={label} orientation="horizontal">
            <Switch {...props} />
            <FieldLabel>{label}</FieldLabel>
          </Field>
        ))}
      </div>
    );
  },
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

export const StatesMobileDark: Story = {
  ...States,
  name: "States (390px, dark)",
  globals: {
    theme: "dark",
    viewport: { value: "mobile390", isRotated: false },
  },
};
