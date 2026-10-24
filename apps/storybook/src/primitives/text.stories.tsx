import type { Meta, StoryObj } from "@storybook/react-vite";
import { Code, Text, type TextProps } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    body: "에이전트가 요청을 받아 세션을 시작했습니다.",
    long: "이 에이전트는 Slack 채널의 요청을 받아 저장소를 읽고, 변경을 제안한 뒤 승인을 기다립니다. 긴 설명은 한 줄에서 잘립니다.",
    count: "세션 1,284개 · 비용 $12.08",
  },
  ja: {
    body: "エージェントがリクエストを受け取り、セッションを開始しました。",
    long: "このエージェントは Slack チャンネルのリクエストを受け取ってリポジトリを読み、変更を提案したあと承認を待ちます。長い説明は 1 行で切れます。",
    count: "セッション 1,284 件 · コスト $12.08",
  },
  en: {
    body: "The agent took the request and started a session.",
    long: "This agent takes requests from a Slack channel, reads the repository, proposes a change and then waits for approval. A long description is cut on one line.",
    count: "1,284 sessions · cost $12.08",
  },
} as const;

type Locale = keyof typeof COPY;
const localeOf = (locale: unknown): Locale =>
  locale === "ja" || locale === "en" ? locale : "ko";

// Each row: the mockup v4 class it draws, then the props.
const SCALE: [string, TextProps][] = [
  [".app (body) 13/20", { variant: "body" }],
  [".sub · .page-desc 13 text-2", { variant: "sub" }],
  [".meta 12 text-3 / 1.5", { variant: "meta" }],
  ["11px (2xs)", { variant: "2xs" }],
  [".strong 500 text", { weight: "medium" }],
  [".mono 12", { mono: true }],
  [".num tabular-nums", { numeric: true }],
];

const meta = {
  title: "Primitives/Text",
  component: Text,
  args: { children: COPY.ko.body },
  argTypes: {
    as: { control: "inline-radio", options: ["p", "span", "div"] },
    variant: {
      control: "inline-radio",
      options: ["body", "sub", "meta", "2xs"],
    },
    weight: { control: "inline-radio", options: [undefined, "medium"] },
  },
} satisfies Meta<typeof Text>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The v4 type scale, one row per variant and modifier. */
export const Scale: Story = {
  render: (_args, { globals }) => {
    const copy = COPY[localeOf(globals.locale)];
    return (
      <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3">
        {SCALE.map(([name, props]) => (
          <div key={name} className="contents">
            <Text variant="meta">
              <Code>{name}</Code>
            </Text>
            <Text {...props}>{props.numeric ? copy.count : copy.body}</Text>
          </div>
        ))}
      </div>
    );
  },
};

export const ScaleDark: Story = {
  ...Scale,
  name: "Scale (dark)",
  globals: { theme: "dark" },
};

/** `truncate` cuts a long line with an ellipsis inside its box. */
export const Truncate: Story = {
  render: (_args, { globals }) => {
    const copy = COPY[localeOf(globals.locale)];
    return (
      <div className="story-stack max-w-80">
        <Text truncate>{copy.long}</Text>
        <Text variant="meta" truncate>
          {copy.long}
        </Text>
        <div>
          <Text as="span" variant="sub" truncate>
            {copy.long}
          </Text>
        </div>
      </div>
    );
  },
};

export const Korean: Story = {
  ...Scale,
  globals: { locale: "ko" },
};

export const Japanese: Story = {
  ...Scale,
  globals: { locale: "ja" },
};

export const English: Story = {
  ...Scale,
  globals: { locale: "en" },
};

export const Mobile390: Story = {
  ...Scale,
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};
