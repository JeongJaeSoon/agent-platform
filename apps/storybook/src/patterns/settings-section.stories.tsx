import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Input,
  SettingRow,
  SettingsSection,
  Switch,
} from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    title: "Slack 게스트",
    description: "게스트 계정이 에이전트를 부를 수 있는지 정합니다.",
    count: "2",
    row: "게스트 호출 허용",
    rowDescription: "끄면 게스트의 멘션에 답하지 않습니다.",
    retention: "감사 기록 보관 기간",
    days: "보관 일수",
    save: "저장",
  },
  ja: {
    title: "Slack ゲスト",
    description: "ゲストアカウントがエージェントを呼べるかを決めます。",
    count: "2",
    row: "ゲストの呼び出しを許可",
    rowDescription: "オフにするとゲストのメンションに応答しません。",
    retention: "監査記録の保存期間",
    days: "保存日数",
    save: "保存",
  },
  en: {
    title: "Slack guests",
    description: "Whether guest accounts can call the agent.",
    count: "2",
    row: "Allow guest calls",
    rowDescription: "When off, the agent ignores guests' mentions.",
    retention: "Audit retention",
    days: "Days kept",
    save: "Save",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

const meta = {
  title: "Patterns/SettingsSection",
  component: SettingsSection,
  args: { title: COPY.ko.title },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <SettingsSection
        {...args}
        title={copy.title}
        badge={<Badge variant="gray">{copy.count}</Badge>}
        description={copy.description}
        rows={
          <SettingRow
            title={copy.row}
            description={copy.rowDescription}
            control={<Switch aria-label={copy.row} defaultChecked />}
          />
        }
      />
    );
  },
} satisfies Meta<typeof SettingsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Title ruled off from the body, a description, then joined rows. */
export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = {
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const English: Story = { globals: { locale: "en" } };

export const TitleOnly: Story = {
  render: (_args, context) => (
    <SettingsSection title={copyFor(context).title} />
  ),
};

/** With `onSubmit` the body and foot are one form; the server checks limits. */
export const Form: Story = {
  render: (_args, context) => {
    const copy = copyFor(context);
    return (
      <SettingsSection
        title={copy.retention}
        onSubmit={(event) => event.preventDefault()}
        foot={
          <Button type="submit" size="sm">
            {copy.save}
          </Button>
        }
      >
        <Input
          aria-label={copy.days}
          className="max-w-50"
          type="number"
          defaultValue={90}
        />
      </SettingsSection>
    );
  },
};
