import type {
  UsageSeriesResponse,
  UsageSummaryResponse,
} from "@werft-ai/contracts";
import { Badge, Sparkline, StatCard } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import type { UsageKpisMessages } from "./messages.ts";
import { Box, Value } from "./placeholders.tsx";
import { useOperationsMessages } from "./use-messages.ts";

type Bucket = UsageSeriesResponse["buckets"][number];

export interface UsageKpisProps {
  /** GET /v1/usage/summary; undefined while it is read. */
  readonly summary: UsageSummaryResponse | undefined;
  /** GET /v1/usage/series `buckets` of the same period; undefined while read. */
  readonly buckets: readonly Bucket[] | undefined;
  readonly messages?: Partial<UsageKpisMessages> | undefined;
}

/** Sessions, run time, cost and tokens of a period, each over its daily line. */
export function UsageKpis({
  summary,
  buckets,
  messages: override,
}: UsageKpisProps): JSX.Element {
  const { messages, format } = useOperationsMessages("usageKpis", override);
  const loading = summary === undefined;
  const spark = (pick: (bucket: Bucket) => number, label: string) =>
    buckets === undefined ? (
      <Box height="2rem" />
    ) : (
      <Sparkline values={buckets.map(pick)} label={label} />
    );
  const value = (
    width: string | undefined,
    text: (s: UsageSummaryResponse) => ReactNode,
  ) => (
    <Value loading={loading} {...(width ? { width } : {})}>
      {summary ? text(summary) : null}
    </Value>
  );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
      <StatCard
        label={messages.sessions}
        value={value(undefined, (s) => format.count(s.session_count))}
        chart={spark((b) => b.session_count, messages.sessionsChart)}
        description={messages.sessionsNote}
      />
      <StatCard
        label={messages.runTime}
        value={value("6rem", (s) => format.duration(s.run_seconds))}
        chart={spark((b) => b.run_seconds, messages.runTimeChart)}
        description={messages.runTimeNote}
      />
      <StatCard
        label={messages.cost}
        badge={<Badge>{messages.estimated}</Badge>}
        value={value("5rem", (s) => format.usd(s.cost_usd))}
        chart={spark((b) => Number(b.cost_usd), messages.costChart)}
        description={
          summary?.cost_complete === false ? messages.costIncomplete : undefined
        }
      />
      <StatCard
        label={messages.tokens}
        value={value("4rem", (s) => format.tokens(s.token_count))}
        chart={spark((b) => b.token_count, messages.tokensChart)}
        description={messages.tokensNote}
      />
      {messages.loading ? (
        <output className="sr-only">
          {loading || buckets === undefined ? messages.loading : ""}
        </output>
      ) : null}
    </div>
  );
}
