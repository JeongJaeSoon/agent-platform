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

// BarChart's rendered height, x labels included.
const BAR_CHART_HEIGHT = "11.25rem";

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
  // Whole $20 steps as the design draws them; a few cents get the chart's own.
  const wide = max >= 20;
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
            <Box chart height={BAR_CHART_HEIGHT} />
          ) : (
            <BarChart
              label={messages.chart(days)}
              data={buckets.map((b) => ({
                x: b.date,
                y: Number(b.cost_usd),
                partial: !b.cost_complete,
              }))}
              {...(wide ? { yMax: Math.ceil(max / 20) * 20 } : {})}
              formatX={monthDay}
              formatY={(y) => (wide ? `$${Math.round(y)}` : format.usd(y))}
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
