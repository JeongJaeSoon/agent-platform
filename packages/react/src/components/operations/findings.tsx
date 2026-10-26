import { cn, EmptyState, RowList, RowListItem, Skeleton } from "@werft-ai/ui";
import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";

import { FindingClock, FindingFailed, FindingSlow } from "./icons.ts";
import type { FindingsMessages } from "./messages.ts";
import type { UsageToolFindingKind, UsageToolsResponse } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

const ICON: Record<UsageToolFindingKind, LucideIcon> = {
  most_time: FindingClock,
  fails_often: FindingFailed,
  slowest: FindingSlow,
};

export interface FindingsProps {
  /** GET /v1/usage/tools as it comes; undefined while read. */
  readonly data: UsageToolsResponse | undefined;
  /** Placeholder rows while `data` is read; the host says it is loading. */
  readonly loadingRows?: number | undefined;
  readonly messages?: Partial<FindingsMessages> | undefined;
  readonly className?: string | undefined;
}

/**
 * "What to look at": one line per finding, the tool's name last so no
 * particle has to agree with it, and the figure that made it a finding.
 */
export function Findings({
  data,
  loadingRows = 3,
  messages: override,
  className,
}: FindingsProps): JSX.Element {
  const { messages, format } = useOperationsMessages("findings", override);
  if (data === undefined) {
    return (
      <RowList variant="joined" aria-hidden="true" className={className}>
        {Array.from({ length: loadingRows }, (_, row) => row).map((row) => (
          <RowListItem key={row} className="min-h-16 flex-nowrap">
            <Skeleton decorative shape="circle" className="size-6" />
            <div className="min-w-0 flex-1">
              <p className="m-0">
                <Skeleton inline decorative width="60%" height="1lh" />
              </p>
              <p className="m-0 text-caption leading-4">
                <Skeleton inline decorative width="40%" height="1lh" />
              </p>
            </div>
          </RowListItem>
        ))}
      </RowList>
    );
  }
  const totalMs = data.tools.reduce((sum, tool) => sum + tool.total_ms, 0);
  const rows = data.findings.flatMap((finding) => {
    const tool = data.tools.find((row) => row.name === finding.name);
    return tool ? [{ finding, tool }] : [];
  });
  if (rows.length === 0) {
    return <EmptyState title={messages.empty} className={className} />;
  }
  const detail = {
    most_time: (tool: (typeof rows)[number]["tool"]) =>
      messages.mostTimeDetail(
        format.elapsed(tool.total_ms),
        Math.round((100 * tool.total_ms) / (totalMs || 1)),
      ),
    fails_often: (tool: (typeof rows)[number]["tool"]) =>
      messages.failsOftenDetail(
        format.count(tool.calls),
        format.count(tool.failed),
        format.percent(tool.failed, tool.calls),
      ),
    slowest: (tool: (typeof rows)[number]["tool"]) =>
      messages.slowestDetail(
        format.elapsed(tool.median_ms),
        format.count(tool.calls),
      ),
  };
  return (
    <RowList variant="joined" data-slot="findings" className={className}>
      {rows.map(({ finding, tool }) => {
        const Icon = ICON[finding.kind];
        return (
          <RowListItem key={finding.kind} className="min-h-16 flex-nowrap">
            <span
              className={cn(
                "grid size-6 flex-none place-items-center rounded-full",
                finding.kind === "fails_often"
                  ? "bg-(color:--ap-tone-danger-bg) text-(color:--ap-tone-danger-fg)"
                  : "bg-(color:--ap-tone-neutral-bg) text-muted-foreground",
              )}
            >
              <Icon aria-hidden="true" className="size-4" strokeWidth={1.5} />
            </span>
            <div className="min-w-0">
              <p className="m-0">
                {messages[finding.kind]}
                {/* leading-none: the mono font's metrics would stretch the line once it loads. */}
                <code className="font-mono text-control leading-none">
                  {tool.name}
                </code>
              </p>
              <p className="m-0 text-caption text-subtle-foreground leading-4">
                {detail[finding.kind](tool)}
              </p>
            </div>
          </RowListItem>
        );
      })}
    </RowList>
  );
}
