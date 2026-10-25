import {
  BarChart,
  KeyValueList,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import { DetailRail, DetailRailSection } from "../layout/detail-layout.tsx";
import type { ToolCallSort, ToolRailMessages } from "./messages.ts";
import { ToolCalls } from "./tool-calls.tsx";
import type { UsageTool, UsageToolCall } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

/** The calls the rail lists; a host asks the API for this many. */
export const TOOL_RAIL_CALLS = 7;
/** The days the chart draws, the period's last. */
export const TOOL_RAIL_DAYS = 14;

const CHART_HEIGHT = "5.25rem";

const monthDay = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export interface ToolRailProps {
  /** The tool shown; undefined until the tools are read. */
  readonly name: string | undefined;
  /** Its GET /v1/usage/tools row; undefined while read. */
  readonly tool: UsageTool | undefined;
  /** A short note under the name, such as "셸 명령"; not an API field. */
  readonly note?: string | undefined;
  /** GET /v1/usage/tools/{name}/calls `per_day`; undefined while read. */
  readonly perDay:
    | readonly { readonly date: string; readonly calls: number }[]
    | undefined;
  /** GET /v1/usage/tools/{name}/calls `calls`; undefined while read. */
  readonly calls: readonly UsageToolCall[] | undefined;
  readonly callSort: ToolCallSort;
  readonly onCallSortChange: (sort: ToolCallSort) => void;
  /** The zone the call times are read in; the viewer's by default. */
  readonly timeZone?: string | undefined;
  /** Shown in place of the chart and calls when they could not be read. */
  readonly error?: ReactNode | undefined;
  readonly messages?: Partial<ToolRailMessages> | undefined;
}

function Value({
  children,
  width = "4rem",
}: {
  readonly children: ReactNode | undefined;
  readonly width?: string;
}) {
  return children === undefined ? (
    <Skeleton
      inline
      decorative
      width={width}
      height="1lh"
      className="justify-center"
    />
  ) : (
    children
  );
}

/**
 * One tool in the rail: its figures, its calls per day and its latest
 * calls. Each part keeps its place while it is read, so nothing moves when
 * it comes; the host says once that the screen is loading.
 */
export function ToolRail({
  name,
  tool,
  note,
  perDay,
  calls,
  callSort,
  onCallSortChange,
  timeZone,
  error,
  messages: override,
}: ToolRailProps): JSX.Element {
  const { messages, format } = useOperationsMessages("toolRail", override);
  const days = perDay?.slice(-TOOL_RAIL_DAYS);
  const peak = days?.reduce(
    (a, b) => (b.calls > a.calls ? b : a),
    days[0] ?? { date: "", calls: 0 },
  );
  const total = days?.reduce((sum, d) => sum + d.calls, 0) ?? 0;
  return (
    <DetailRail label={messages.label}>
      <DetailRailSection
        title={
          <Text as="span" mono className="text-body font-semibold leading-5">
            <Value width="5rem">{name}</Value>
          </Text>
        }
        description={note}
      >
        <KeyValueList
          items={[
            {
              label: messages.calls,
              value: tool && messages.callsValue(format.count(tool.calls)),
            },
            {
              label: messages.total,
              value: tool && format.duration(tool.total_ms / 1000),
            },
            {
              label: messages.median,
              value: tool && format.elapsed(tool.median_ms),
            },
            {
              label: messages.failed,
              value:
                tool &&
                messages.failedValue(
                  format.count(tool.failed),
                  format.percent(tool.failed, tool.calls),
                ),
            },
          ].map((item) => ({
            label: item.label,
            value: <Value>{item.value}</Value>,
          }))}
        />
      </DetailRailSection>
      <DetailRailSection
        title={messages.perDay}
        description={messages.perDayNote(days?.length ?? TOOL_RAIL_DAYS)}
      >
        {error ? (
          error
        ) : days === undefined || peak === undefined || name === undefined ? (
          <Skeleton
            decorative
            shape="block"
            height={CHART_HEIGHT}
            className="justify-center"
          />
        ) : (
          <BarChart
            compact
            data={days.map((d) => ({ x: d.date, y: d.calls }))}
            yMax={peak.calls}
            label={messages.perDayChart({
              name,
              days: days.length,
              total: format.count(total),
              peakDay: monthDay(peak.date),
              peak: format.count(peak.calls),
            })}
            formatX={monthDay}
          />
        )}
      </DetailRailSection>
      {error ? null : (
        <DetailRailSection
          title={messages.recent}
          actions={
            <SegmentedControl
              aria-label={messages.callSort}
              value={callSort}
              onValueChange={(value) => onCallSortChange(value as ToolCallSort)}
            >
              <SegmentedControlItem value="recent">
                {messages.callSortBy.recent}
              </SegmentedControlItem>
              <SegmentedControlItem value="slowest">
                {messages.callSortBy.slowest}
              </SegmentedControlItem>
            </SegmentedControl>
          }
        >
          <ToolCalls
            calls={calls}
            loadingRows={TOOL_RAIL_CALLS}
            timeZone={timeZone}
          />
        </DetailRailSection>
      )}
    </DetailRail>
  );
}
