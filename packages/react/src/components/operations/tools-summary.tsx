import { Skeleton } from "@werft-ai/ui";
import type { JSX } from "react";

import type { ToolsSummaryMessages } from "./messages.ts";
import type { UsageTool } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

export interface ToolsSummaryProps {
  /** GET /v1/usage/tools `tools`; undefined while read. */
  readonly tools: readonly UsageTool[] | undefined;
  /** The period in words, e.g. "최근 30일". */
  readonly period: string;
  readonly messages?: Partial<ToolsSummaryMessages> | undefined;
}

/** The tools tab's lead: calls, time spent and failures over the period. */
export function ToolsSummary({
  tools,
  period,
  messages: override,
}: ToolsSummaryProps): JSX.Element {
  const { messages, format } = useOperationsMessages("toolsSummary", override);
  if (tools === undefined) {
    // The sentence is one 24px line from about 40rem of its container (the
    // host's @container), two below.
    return (
      <Skeleton
        decorative
        lines={2}
        className="h-12 justify-around @min-[40rem]:h-6 @min-[40rem]:justify-center @min-[40rem]:[&>:nth-child(2)]:hidden"
      />
    );
  }
  const calls = tools.reduce((sum, tool) => sum + tool.calls, 0);
  const failed = tools.reduce((sum, tool) => sum + tool.failed, 0);
  const totalMs = tools.reduce((sum, tool) => sum + tool.total_ms, 0);
  const parts = messages.sentence({
    period,
    calls: format.count(calls),
    time: format.duration(totalMs / 1000),
    failed: format.count(failed),
    rate: format.percent(failed, calls),
  });
  return (
    <p data-slot="tools-summary" className="m-0 text-body leading-6">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : "strong" in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the sentence's parts are fixed per locale
          <b key={index} className="font-semibold tabular-nums">
            {part.strong}
          </b>
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: as above
            key={index}
            className="font-semibold text-(color:--ap-tone-danger-fg) tabular-nums"
          >
            {part.danger}
          </span>
        ),
      )}
    </p>
  );
}
