import type { Meta, StoryObj } from "@storybook/react-vite";
import { BarChart, type BarChartDatum, BarChartLegend } from "@werft-ai/ui";
import { expect, userEvent, within } from "storybook/test";

// Thirty UTC days of estimated cost, weekends lower; two days still have
// turns that reported no cost (GET /v1/usage/series `cost_complete=false`).
const DAYS: readonly (BarChartDatum & { readonly sessions: number })[] =
  Array.from({ length: 30 }, (_, i) => {
    const weekend = i % 7 === 5 || i % 7 === 6;
    const cost = Math.max(
      6,
      28 + 14 * Math.sin(i / 3.2) + (weekend ? -18 : 0) + i * 0.6,
    );
    return {
      x: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10),
      y: Number(cost.toFixed(2)),
      partial: i === 12 || i === 29,
      sessions: Math.max(
        2,
        Math.round(13 + 5 * Math.sin(i / 2.6) + (weekend ? -8 : 0) + i * 0.15),
      ),
    };
  });
const CALLS = [52, 61, 70, 44, 18, 12, 66, 73, 80, 69, 75, 21, 15, 64].map(
  (y, i) => ({ x: `2026-10-${String(10 + i).padStart(2, "0")}`, y }),
);

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    label: "일자별 추정 비용, 30일",
    sessions: (n: number) => `세션 ${n}개`,
    partial: "보고 안 된 비용 있음",
    done: "비용 보고 끝남",
    calls: "Bash 일자별 호출, 최근 14일, 합계 720번, 가장 많은 날 10/18 80번",
  },
  ja: {
    label: "日別の推定費用、30日",
    sessions: (n: number) => `セッション${n}件`,
    partial: "未報告の費用あり",
    done: "費用の報告済み",
    calls: "Bash の日別呼び出し、直近14日、合計720回、最多は10/18の80回",
  },
  en: {
    label: "Estimated cost per day, 30 days",
    sessions: (n: number) => `${n} sessions`,
    partial: "Some cost not reported",
    done: "Cost reported",
    calls: "Bash calls per day, last 14 days, 720 in total, most on 10/18 (80)",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

const monthDay = (x: string) =>
  `${Number(x.slice(5, 7))}/${Number(x.slice(8))}`;
const usd = (y: number) =>
  `$${y.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Takes the copy, not the story context: Storybook's source snippet walks a
// rendered element's props, and the context reaches the DOM.
function Chart({
  data,
  copy,
}: {
  readonly data: readonly BarChartDatum[];
  readonly copy: (typeof COPY)[keyof typeof COPY];
}) {
  return (
    <div className="flex flex-col gap-3">
      <BarChartLegend
        items={[{ label: copy.done }, { label: copy.partial, partial: true }]}
      />
      <BarChart
        data={data}
        label={copy.label}
        formatX={monthDay}
        formatY={(y) => `$${Math.round(y)}`}
        formatTip={(d) => {
          const day = DAYS.find((row) => row.x === d.x);
          return [
            monthDay(d.x),
            usd(d.y),
            copy.sessions(day?.sessions ?? 0),
            ...(d.partial ? [copy.partial] : []),
          ].join(" · ");
        }}
      />
    </div>
  );
}

/**
 * One series over days, in greys. A day with unreported cost is hatched,
 * not coloured. The whole chart is one Tab stop; ← → Home End move between
 * days and the focused or hovered bar shows its tooltip.
 */
const meta = {
  title: "Patterns/BarChart",
  component: BarChart,
  args: { data: DAYS, label: COPY.ko.label, formatX: monthDay },
  render: (args, context) => <Chart data={args.data} copy={copyFor(context)} />,
} satisfies Meta<typeof BarChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { data: DAYS.map(({ partial: _, ...day }) => day) },
};

export const Partial: Story = {};

export const Empty: Story = { args: { data: [] } };

/** The tools rail's summary: no axis, no focus, the label says it all. */
export const Compact: Story = {
  render: (_args, context) => (
    <div className="max-w-[336px]">
      <BarChart
        compact
        data={CALLS}
        label={copyFor(context).calls}
        formatX={monthDay}
      />
    </div>
  ),
};

/** Tab once into the chart, then the arrows walk the days. */
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    const bars = canvas.getAllByRole("button");
    await expect(bars.filter((bar) => bar.tabIndex === 0)).toHaveLength(1);
    await userEvent.keyboard("{Home}{ArrowRight}");
    await expect(bars[1]).toHaveFocus();
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };
