import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge, Button, Card, CardContent, Section } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    title: "자격 증명",
    badge: "연결됨",
    description: "에이전트가 외부 서비스에 쓰는 키입니다.",
    action: "키 추가",
    body: "등록된 키 2개",
    second: "최근 실행",
  },
  ja: {
    title: "認証情報",
    badge: "接続済み",
    description: "エージェントが外部サービスで使うキーです。",
    action: "キーを追加",
    body: "登録済みのキー 2件",
    second: "最近の実行",
  },
  en: {
    title: "Credentials",
    badge: "Connected",
    description: "Keys the agent uses with outside services.",
    action: "Add key",
    body: "2 keys registered",
    second: "Recent runs",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

const meta = {
  title: "Patterns/Section",
  component: Section,
  args: { title: COPY.ko.title },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <Section
        {...args}
        title={copy.title}
        badge={<Badge variant="green">{copy.badge}</Badge>}
        description={copy.description}
        actions={
          <Button type="button" variant="outline" size="sm">
            {copy.action}
          </Button>
        }
      >
        <Card>
          <CardContent>{copy.body}</CardContent>
        </Card>
      </Section>
    );
  },
} satisfies Meta<typeof Section>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Head 28px tall and 12px above the content (decision C3). */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/**
 * The space between sections belongs to the page (mockup v4 `.section`
 * margin-top 32): the screen sets it, the part does not.
 */
export const Stacked: Story = {
  render: (_args, context) => {
    const copy = copyFor(context);
    return (
      <div className="flex flex-col gap-8">
        <Section
          title={copy.title}
          badge={<Badge variant="green">{copy.badge}</Badge>}
        >
          <Card>
            <CardContent>{copy.body}</CardContent>
          </Card>
        </Section>
        <Section title={copy.second} titleAs="h2">
          <Card>
            <CardContent>{copy.body}</CardContent>
          </Card>
        </Section>
      </div>
    );
  },
};

export const Mobile: Story = {
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

export const English: Story = { globals: { locale: "en" } };
