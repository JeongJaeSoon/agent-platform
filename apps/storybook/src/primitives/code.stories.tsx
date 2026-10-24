import type { Meta, StoryObj } from "@storybook/react-vite";
import { Code, CodeBlock, Text } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: { inline: ["환경 변수", "에 토큰을 넣고", "를 다시 실행합니다."] },
  ja: { inline: ["環境変数", "にトークンを入れ、", "を再実行します。"] },
  en: { inline: ["Put the token in the", "variable and run", "again."] },
} as const;

type Locale = keyof typeof COPY;
const localeOf = (locale: unknown): Locale =>
  locale === "ja" || locale === "en" ? locale : "ko";

// A tool call's output in the session timeline (v4 `.ev .code`).
const TOOL_OUTPUT = `$ bun test packages/ui
bun test v1.3.14

 412 pass
 0 fail
Ran 412 tests across 38 files. [2.41s]`;

const LONG_LINE =
  "error: request to https://api.example.com/v1/workspaces/ws_01HZX4Q8/agents/ag_7KQ2/sessions?cursor=eyJpZCI6InNlc3NfOTk5In0 failed with status 503 (upstream_unavailable)";

const meta = {
  title: "Primitives/Code",
  component: Code,
  args: { children: "AP_TOKEN" },
} satisfies Meta<typeof Code>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

function Sentence({ locale }: { readonly locale: unknown }) {
  const [before, middle, after] = COPY[localeOf(locale)].inline;
  return (
    <Text>
      {before} <Code>AP_TOKEN</Code> {middle} <Code>agent-platform run</Code>{" "}
      {after}
    </Text>
  );
}

/** Code inside a sentence: 12px mono, no fill. */
export const Inline: Story = {
  render: (_args, { globals }) => <Sentence locale={globals.locale} />,
};

/** v4 `.code`: tool output over several lines, newlines kept. */
export const Block: Story = {
  render: () => <CodeBlock>{TOOL_OUTPUT}</CodeBlock>,
};

export const BlockDark: Story = {
  ...Block,
  name: "Block (dark)",
  globals: { theme: "dark" },
};

/** A long unbroken line wraps instead of widening the page. */
export const LongLine: Story = {
  render: () => <CodeBlock>{LONG_LINE}</CodeBlock>,
};

export const Mobile390: Story = {
  render: (_args, { globals }) => (
    <div className="story-stack">
      <Sentence locale={globals.locale} />
      <CodeBlock>{TOOL_OUTPUT}</CodeBlock>
      <CodeBlock>{LONG_LINE}</CodeBlock>
    </div>
  ),
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const Mobile390Dark: Story = {
  ...Mobile390,
  name: "Mobile390 (dark)",
  globals: { ...Mobile390.globals, theme: "dark" },
};
