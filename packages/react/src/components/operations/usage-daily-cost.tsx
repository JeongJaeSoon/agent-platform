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
              {...(designSteps
                ? {
                    yMax:
                      Math.ceil(max / DESIGN_Y_STEP_USD) * DESIGN_Y_STEP_USD,
                  }
                : {})}
              formatX={monthDay}
              formatY={(y) =>
                designSteps ? `$${Math.round(y)}` : format.usd(y)
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
