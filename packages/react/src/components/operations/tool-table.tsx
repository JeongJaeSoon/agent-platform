import {
  Card,
  cn,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Meter,
  Skeleton,
} from "@werft-ai/ui";
import type { JSX } from "react";

import type { ToolTableMessages } from "./messages.ts";
import type { UsageTool } from "./tools.ts";
import { useOperationsMessages } from "./use-messages.ts";

// Name, calls, total, median, failed; at 480px and under the two times go.
const COLUMNS = "minmax(0,1fr) 56px 80px 64px 56px";
const NARROW_COLUMNS = "minmax(0,1fr) 56px 56px";

export interface ToolTableProps {
  /** GET /v1/usage/tools `tools`, in the order to show; undefined while read. */
  readonly tools: readonly UsageTool[] | undefined;
  /** Names the table, e.g. "도구와 명령". */
  readonly label: string;
  /** The `name` of the row shown in the rail. */
  readonly selected?: string | undefined;
  readonly onSelect?: ((name: string) => void) | undefined;
  /** A short note under a name, such as "셸 명령"; not an API field. */
  readonly describe?: ((name: string) => string | undefined) | undefined;
  /** Placeholder rows while `tools` is read, e.g. the last count seen. */
  readonly loadingRows?: number | undefined;
  readonly messages?: Partial<ToolTableMessages> | undefined;
}

/**
 * Tools by calls, time and failures. A row opens in the rail: its opener is a
 * toggle button, pressed for the row shown, since the table is
 * role="table" and its rows cannot be selected.
 */
export function ToolTable({
  tools,
  label,
  selected,
  onSelect,
  describe,
  loadingRows = 3,
  messages: override,
}: ToolTableProps): JSX.Element {
  const { messages, format } = useOperationsMessages("toolTable", override);
  if (tools?.length === 0) return <EmptyState title={messages.empty} />;
  const most = Math.max(0, ...(tools ?? []).map((tool) => tool.calls));
  return (
    <Card flush>
      <GridTable
        aria-label={label}
        aria-busy={tools === undefined || undefined}
        columns={COLUMNS}
        narrowAt={480}
        narrowColumns={NARROW_COLUMNS}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{messages.name}</GridTableColumnHeader>
          <GridTableColumnHeader align="end">
            {messages.calls}
          </GridTableColumnHeader>
          <GridTableColumnHeader align="end" hideNarrow>
            {messages.total}
          </GridTableColumnHeader>
          <GridTableColumnHeader align="end" hideNarrow>
            {messages.median}
          </GridTableColumnHeader>
          <GridTableColumnHeader align="end">
            {messages.failed}
          </GridTableColumnHeader>
        </GridTableHeader>
        {tools === undefined
          ? Array.from({ length: loadingRows }, (_, row) => row).map((row) => (
              <GridTableRow key={row}>
                {/* A tool row's lines at their heights, so rows do not grow
                    when the tools come; the table says it once. */}
                <GridTableCell lines className="gap-1">
                  <Skeleton
                    decorative
                    width="40%"
                    height="1lh"
                    className="justify-center"
                  />
                  {describe ? (
                    <Skeleton
                      decorative
                      width="25%"
                      height="1lh"
                      className="justify-center text-caption"
                    />
                  ) : null}
                  <Skeleton decorative height="0.25rem" />
                  {row === 0 ? (
                    <span className="sr-only">{messages.loading}</span>
                  ) : null}
                </GridTableCell>
                <GridTableCell />
                <GridTableCell hideNarrow />
                <GridTableCell hideNarrow />
                <GridTableCell />
              </GridTableRow>
            ))
          : tools.map((tool) => {
              const pressed = tool.name === selected;
              const note = describe?.(tool.name);
              return (
                <GridTableRow
                  key={tool.name}
                  data-selected={pressed || undefined}
                  className={cn(pressed && "bg-active hover:bg-active")}
                >
                  <GridTableCell lines className="gap-1">
                    <GridTableRowOpener
                      aria-label={messages.open(tool.name)}
                      aria-pressed={pressed}
                      onClick={() => onSelect?.(tool.name)}
                    />
                    <span className="font-mono">{tool.name}</span>
                    {note ? (
                      <span className="text-caption text-subtle-foreground">
                        {note}
                      </span>
                    ) : null}
                    <Meter
                      size="inline"
                      value={tool.calls}
                      max={most}
                      label={messages.callsMeter(tool.name)}
                      className="w-full"
                    />
                  </GridTableCell>
                  <GridTableCell align="end" className="tabular-nums">
                    {format.count(tool.calls)}
                  </GridTableCell>
                  <GridTableCell
                    align="end"
                    hideNarrow
                    className="tabular-nums"
                  >
                    {format.duration(tool.total_ms / 1000)}
                  </GridTableCell>
                  <GridTableCell
                    align="end"
                    hideNarrow
                    className="tabular-nums"
                  >
                    {format.elapsed(tool.median_ms)}
                  </GridTableCell>
                  <GridTableCell
                    align="end"
                    className={cn(
                      "tabular-nums",
                      tool.failed > 0 && "text-(color:--ap-tone-danger-fg)",
                    )}
                  >
                    {format.count(tool.failed)}
                  </GridTableCell>
                </GridTableRow>
              );
            })}
      </GridTable>
    </Card>
  );
}
