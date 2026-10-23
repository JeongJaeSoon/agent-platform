import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@werft-ai/ui";

const meta = {
  title: "Primitives/Badge",
  component: Badge,
  args: { children: "기본" },
  argTypes: {
    variant: {
      control: "select",
      options: ["gray", "blue", "green", "amber", "red", "mono"],
    },
    dot: {
      control: "select",
      options: [undefined, "wait", "run", "idle", "done", "failed"],
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

// The toolbar's Language picks the label, so each catalog's width shows.
const LABEL: Record<string, string> = { ko: "초안", ja: "下書き", en: "Draft" };

export const Default: Story = {
  render: (args, { globals }) => (
    <Badge {...args}>{LABEL[globals.locale] ?? LABEL.ko}</Badge>
  ),
};

/** Console v35's five badge tones. */
export const Tones: Story = {
  render: () => (
    <div className="story-row">
      <Badge variant="gray">초안</Badge>
      <Badge variant="blue">진행 중</Badge>
      <Badge variant="green">연결됨</Badge>
      <Badge variant="amber">확인 필요</Badge>
      <Badge variant="red">실패</Badge>
    </div>
  ),
};

export const TonesDark: Story = {
  ...Tones,
  name: "Tones (dark)",
  globals: { theme: "dark" },
};

/** Identifiers such as model names, as a chip list (mockup v4). */
export const Mono: Story = {
  render: () => (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
      {["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map(
        (model) => (
          <li key={model}>
            <Badge variant="mono">{model}</Badge>
          </li>
        ),
      )}
    </ul>
  ),
};

export const MonoDark: Story = {
  ...Mono,
  name: "Mono (dark)",
  globals: { theme: "dark" },
};

const STATUS_LABEL = {
  ko: ["답변 대기", "실행 중", "쉬는 중", "끝남", "실패"],
  ja: ["回答待ち", "実行中", "待機中", "完了", "失敗"],
  en: ["Waiting", "Running", "Idle", "Done", "Failed"],
} as const;

const DOTS = [
  { dot: "wait", variant: "amber" },
  { dot: "run", variant: "blue" },
  { dot: "idle", variant: "gray" },
  { dot: "done", variant: "green" },
  { dot: "failed", variant: "red" },
] as const;

/** A session's status in its page head: the dot, then the status's name. */
export const Dots: Story = {
  render: (_args, { globals }) => {
    const locale: string = globals.locale;
    const labels =
      STATUS_LABEL[locale === "ja" || locale === "en" ? locale : "ko"];
    return (
      <div className="story-row">
        {DOTS.map(({ dot, variant }, index) => (
          <Badge key={dot} variant={variant} dot={dot}>
            {labels[index]}
          </Badge>
        ))}
      </div>
    );
  },
};

export const DotsDark: Story = {
  ...Dots,
  name: "Dots (dark)",
  globals: { theme: "dark" },
};

export const DotsMobile: Story = {
  ...Dots,
  name: "Dots (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
