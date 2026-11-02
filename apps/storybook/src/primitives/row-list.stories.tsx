import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, RowLines, RowLink, RowList, RowListItem } from "@werft-ai/ui";
import { expect } from "storybook/test";

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

/** Each row opens as a whole through its name link; no Open button. */
function OpeningTeams({ locale }: { readonly locale: unknown }) {
  const t = COPY[(locale as Locale) in COPY ? (locale as Locale) : "ko"];
  return (
    <RowList variant="joined">
      {t.teams.map((team) => (
        <RowListItem key={team.name} opens={true}>
          <RowLines>
            <RowLink>
              <a
                href={`#teams/${team.name}`}
                className="font-semibold text-foreground no-underline [overflow-wrap:anywhere]"
              >
                {team.name}
              </a>
            </RowLink>
            <span className="text-muted-foreground text-xs">{team.detail}</span>
          </RowLines>
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

/**
 * `opens` with a RowLink: the name link's box covers the row, so a click
 * anywhere on it follows the link, and the row is one Tab stop.
 */
export const OpensAsWhole: Story = {
  name: "Opens as a whole",
  render: (_, { globals }) => <OpeningTeams locale={globals.locale} />,
  play: async ({ canvasElement }) => {
    for (const row of canvasElement.querySelectorAll("li")) {
      const link = row.querySelector("a");
      const detail = row.querySelector("span.text-xs");
      if (!(link && detail)) throw new Error("no row link");
      const box = detail.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      await expect(hit === link).toBe(true);
    }
  },
};

export const OpensAsWholeDark: Story = {
  ...OpensAsWhole,
  name: "Opens as a whole (dark)",
  globals: { theme: "dark" },
};

export const OpensAsWholeMobile: Story = {
  ...OpensAsWhole,
  name: "Opens as a whole (390px)",
  globals: {
    locale: "en",
    viewport: { value: "mobile390", isRotated: false },
  },
};
