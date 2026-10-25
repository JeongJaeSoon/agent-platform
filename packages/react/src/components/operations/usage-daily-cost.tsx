import type { UsageSeriesResponse } from "@werft-ai/contracts";
import {
  BarChart,
  BarChartLegend,
  Card,
  CardContent,
  Section,
} from "@werft-ai/ui";
import type { JSX } from "react";

import type { UsageDailyCostMessages } from "./messages.ts";
import { Box } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

type Bucket = UsageSeriesResponse["buckets"][number];

const BAR_CHART_HEIGHT_WITH_X_LABELS = "11.25rem";
const DESIGN_Y_STEP_USD = 20;

const Y_STEPS = 4;
// 1 or 2 × 10^n, so every tick of a sub-cent axis is one significant digit
// and fits the axis column.
const tinyStep = (max: number) => {
  const want = max / Y_STEPS;
  const unit = 10 ** Math.floor(Math.log10(want));
  return (want <= unit ? 1 : want <= 2 * unit ? 2 : 10) * unit;
};

const monthDay = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export interface UsageDailyCostProps {
  /** GET /v1/usage/series `buckets`; undefined while they are read. */
  readonly buckets: readonly Bucket[] | undefined;
  readonly days: number;
  readonly messages?: Partial<UsageDailyCostMessages> | undefined;
}

/** Each day's estimated cost; a day with unreported cost is hatched. */
export function UsageDailyCost({
  buckets,
  days,
  messages: override,
}: UsageDailyCostProps): JSX.Element {
  const { messages, format } = useOperationsMessages(
    "usageDailyCost",
    override,
  );
  const max = Math.max(0, ...(buckets ?? []).map((b) => Number(b.cost_usd)));
  const designSteps = max >= DESIGN_Y_STEP_USD;
  const tiny = max > 0 && max < 0.01;
  const yMax = designSteps
    ? Math.ceil(max / DESIGN_Y_STEP_USD) * DESIGN_Y_STEP_USD
    : tiny
      ? Y_STEPS * tinyStep(max)
      : undefined;
  return (
    <Section
      title={messages.title}
      description={messages.description}
      actions={
        <BarChartLegend
          items={[
            { label: messages.complete },
            { label: messages.partial, partial: true },
          ]}
        />
      }
    >
      <Card>
        <CardContent>
          {buckets === undefined ? (
            <Box chart height={BAR_CHART_HEIGHT_WITH_X_LABELS} />
          ) : (
            <BarChart
              label={messages.chart(days)}
              data={buckets.map((b) => ({
                x: b.date,
                y: Number(b.cost_usd),
                partial: !b.cost_complete,
              }))}
              {...(yMax === undefined ? {} : { yMax })}
              formatX={monthDay}
              formatY={(y) =>
                designSteps
                  ? `$${Math.round(y)}`
                  : tiny
                    ? `$${Number(y.toPrecision(1))}`
                    : format.usd(y)
              }
              formatTip={(d) =>
                messages.tip(
                  monthDay(d.x),
                  format.usd(d.y),
                  format.count(
                    buckets.find((b) => b.date === d.x)?.session_count ?? 0,
                  ),
                  d.partial ?? false,
                )
              }
            />
          )}
        </CardContent>
      </Card>
    </Section>
  );
}
