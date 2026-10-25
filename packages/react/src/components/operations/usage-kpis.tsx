import type { UsageSeriesResponse } from "@werft-ai/contracts";
import { Badge, Sparkline, StatCard } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import type { UsageKpisMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

type Bucket = UsageSeriesResponse["buckets"][number];

interface Totals {
  readonly session_count: number;
  readonly run_seconds: number;
  readonly cost_usd: number;
  readonly cost_complete: boolean;
  readonly token_count: number;
}

/** The period's figures: the series buckets add up to its summary. */
function totalsOf(buckets: readonly Bucket[]): Totals {
  return {
    session_count: buckets.reduce((sum, b) => sum + b.session_count, 0),
    run_seconds: buckets.reduce((sum, b) => sum + b.run_seconds, 0),
    cost_usd: buckets.reduce((sum, b) => sum + Number(b.cost_usd), 0),
    cost_complete: buckets.every((b) => b.cost_complete),
    token_count: buckets.reduce((sum, b) => sum + b.token_count, 0),
  };
}

export interface UsageKpisProps {
  /** GET /v1/usage/series `buckets` of the period; undefined while read. */
  readonly buckets: readonly Bucket[] | undefined;
  readonly messages?: Partial<UsageKpisMessages> | undefined;
}

/** Sessions, run time, cost and tokens of a period, each over its daily line. */
export function UsageKpis({
  buckets,
  messages: override,
}: UsageKpisProps): JSX.Element {
  const { messages, format } = useOperationsMessages("usageKpis", override);
  const totals = buckets === undefined ? undefined : totalsOf(buckets);
  const loading = totals === undefined;
  const spark = (pick: (bucket: Bucket) => number, label: string) =>
    buckets === undefined ? (
      <Box height="2rem" />
    ) : (
      <Sparkline values={buckets.map(pick)} label={label} />
    );
  const value = (width: string | undefined, text: (t: Totals) => ReactNode) => (
    <Value loading={loading} {...(width ? { width } : {})}>
      {totals ? text(totals) : null}
    </Value>
  );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
      <StatCard
        label={messages.sessions}
        value={value(undefined, (t) => format.count(t.session_count))}
        chart={spark((b) => b.session_count, messages.sessionsChart)}
        description={messages.sessionsNote}
      />
      <StatCard
        label={messages.runTime}
        value={value("6rem", (t) => format.duration(t.run_seconds))}
        chart={spark((b) => b.run_seconds, messages.runTimeChart)}
        description={messages.runTimeNote}
      />
      <StatCard
        label={messages.cost}
        badge={<Badge>{messages.estimated}</Badge>}
        value={value("5rem", (t) => format.usd(t.cost_usd))}
        chart={spark((b) => Number(b.cost_usd), messages.costChart)}
        description={
          totals === undefined ? (
            // Unknown until read; most periods hold a running turn, so its
            // room is kept and the card does not grow when the answer comes.
            <span aria-hidden="true" className="invisible">
              {messages.costIncomplete}
            </span>
          ) : totals.cost_complete ? undefined : (
            messages.costIncomplete
          )
        }
      />
      <StatCard
        label={messages.tokens}
        value={value("4rem", (t) => format.tokens(t.token_count))}
        chart={spark((b) => b.token_count, messages.tokensChart)}
        description={messages.tokensNote}
      />
      {messages.loading ? (
        <output className="sr-only">{loading ? messages.loading : ""}</output>
      ) : null}
    </div>
  );
}
