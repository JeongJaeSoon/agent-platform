import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, RowLines, RowList, RowListItem } from "@werft-ai/ui";

type Locale = "ko" | "ja" | "en";

const COPY = {
  ko: {
    teams: [
      { name: "결제 담당", detail: "구성원 4명 · 에이전트 2개" },
      { name: "고객 지원", detail: "구성원 12명 · 에이전트 5개" },
      { name: "인프라 운영과 보안 점검", detail: "구성원 1명" },
    ],
    open: "열기",
    openFor: (name: string) => `${name} 열기`,
  },
  ja: {
    teams: [
      { name: "決済担当", detail: "メンバー4人・エージェント2個" },
      { name: "カスタマーサポート", detail: "メンバー12人・エージェント5個" },
      { name: "インフラ運用とセキュリティ点検", detail: "メンバー1人" },
    ],
    open: "開く",
    openFor: (name: string) => `${name}を開く`,
  },
  en: {
    teams: [
      { name: "Billing", detail: "4 members · 2 agents" },
      { name: "Customer support", detail: "12 members · 5 agents" },
      {
        name: "Infrastructure operations and security review",
        detail: "1 member",
      },
    ],
    open: "Open",
    openFor: (name: string) => `Open ${name}`,
  },
} satisfies Record<Locale, unknown>;

function Teams({
  locale,
  variant,
}: {
  readonly locale: unknown;
  readonly variant: "separate" | "joined";
}) {
  const t = COPY[(locale as Locale) in COPY ? (locale as Locale) : "ko"];
  return (
    <RowList variant={variant}>
      {t.teams.map((team) => (
        <RowListItem key={team.name}>
          <RowLines>
            <span className="font-semibold">{team.name}</span>
            <span className="text-muted-foreground text-xs">{team.detail}</span>
          </RowLines>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t.openFor(team.name)}
          >
            {t.open}
          </Button>
        </RowListItem>
      ))}
    </RowList>
  );
}

const meta = {
  title: "Primitives/RowList",
  component: RowList,
} satisfies Meta<typeof RowList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each row its own card, 8px apart. */
export const Separate: Story = {
  render: (_, { globals }) => (
    <Teams locale={globals.locale} variant="separate" />
  ),
};

/** One card with a rule between rows, like a table. */
export const Joined: Story = {
  render: (_, { globals }) => (
    <Teams locale={globals.locale} variant="joined" />
  ),
};

/** Both variants, so dark, 390px and each language cover them together. */
export const Variants: Story = {
  render: (_, { globals }) => (
    <div className="flex flex-col gap-6">
      <Teams locale={globals.locale} variant="separate" />
      <Teams locale={globals.locale} variant="joined" />
    </div>
  ),
};

export const Dark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};

/** A row too narrow for its button wraps it 8px under the text. */
export const Mobile390: Story = {
  ...Variants,
  name: "Variants (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Korean: Story = {
  ...Variants,
  name: "Variants (ko)",
  globals: { locale: "ko" },
};

export const Japanese: Story = {
  ...Variants,
  name: "Variants (ja)",
  globals: { locale: "ja" },
};

export const English: Story = {
  ...Variants,
  name: "Variants (en)",
  globals: { locale: "en" },
};
