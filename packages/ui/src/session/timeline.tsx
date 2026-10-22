import type { TurnEventPart, TurnEventPresentation } from "@werft-ai/contracts";
import type { JSX } from "react";

import { cn } from "../lib/cn.ts";
import {
  formatTimestamp,
  type TimestampLocale,
} from "../receipt/format-timestamp.ts";
import { type FormatTurnMessage, turnSummaryText } from "./turn-text.ts";

export interface TimelineEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly turnId: string | null;
  /** presentTurnEvent's reading, with the tool call paired by the screen. */
  readonly presentation: TurnEventPresentation;
}

export interface TimelineMessages {
  /** Names the list for screen readers. */
  readonly label: string;
  readonly empty: string;
  readonly connecting: string;
  readonly closed: string;
  readonly turn: (turnId: string) => string;
}

export interface TimelineProps {
  readonly entries: readonly TimelineEntry[];
  readonly formatMessage: FormatTurnMessage;
  readonly messages: TimelineMessages;
  /** The event stream: `connecting` and `closed` say so above the list. */
  readonly state?: "connecting" | "open" | "closed" | undefined;
  /** Shows the events presentTurnEvent marks `fold: "debug"`. */
  readonly showDebug?: boolean | undefined;
  readonly locale?: TimestampLocale | undefined;
  readonly className?: string | undefined;
}

interface TimelineRow extends TimelineEntry {
  readonly key: string;
}

function withCount(
  summary: readonly TurnEventPart[],
  count: number,
): TurnEventPart[] {
  return summary.map((part) =>
    "key" in part ? { ...part, params: { ...part.params, count } } : part,
  );
}

function timelineRows(
  entries: readonly TimelineEntry[],
  showDebug: boolean,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let ticks = 0;
  for (const entry of entries) {
    const { presentation } = entry;
    if (presentation.fold === "debug" && !showDebug) continue;
    if (presentation.fold === "thinking_tick") {
      const last = rows.at(-1);
      // A run of ticks in one turn reads as one line; it keeps the run's
      // first key so the row does not remount as the count grows.
      ticks = ticks > 0 && last?.turnId === entry.turnId ? ticks + 1 : 1;
      const row = {
        ...entry,
        key: ticks > 1 && last ? last.key : entry.id,
        presentation: {
          ...presentation,
          summary: withCount(presentation.summary, ticks),
        },
      };
      if (ticks > 1) rows[rows.length - 1] = row;
      else rows.push(row);
      continue;
    }
    ticks = 0;
    // Nothing to say: a row here would be an empty card.
    if (presentation.summary.length > 0) rows.push({ ...entry, key: entry.id });
  }
  return rows;
}

export function Timeline({
  entries,
  formatMessage,
  messages,
  state = "open",
  showDebug = false,
  locale = "ko",
  className,
}: TimelineProps): JSX.Element {
  const rows = timelineRows(entries, showDebug);
  return (
    <div data-slot="timeline" className={cn("flex flex-col gap-2", className)}>
      {state === "open" ? null : (
        <output className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-body">
          {state === "connecting" ? messages.connecting : messages.closed}
        </output>
      )}
      {rows.length === 0 ? (
        state === "open" ? (
          <p className="text-muted-foreground text-body">{messages.empty}</p>
        ) : null
      ) : (
        <ol aria-label={messages.label} className="flex flex-col">
          {rows.map((row) => (
            <TimelineItem
              key={row.key}
              row={row}
              formatMessage={formatMessage}
              messages={messages}
              locale={locale}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function TimelineItem({
  row,
  formatMessage,
  messages,
  locale,
}: {
  readonly row: TimelineRow;
  readonly formatMessage: FormatTurnMessage;
  readonly messages: TimelineMessages;
  readonly locale: TimestampLocale;
}): JSX.Element {
  const { presentation } = row;
  const error = presentation.error === true;
  const summary = turnSummaryText(presentation.summary, formatMessage);
  const summaryClass = cn(
    "min-w-0 text-body [overflow-wrap:anywhere]",
    error && "text-destructive",
  );
  return (
    <li
      data-error={error || undefined}
      className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 border-b py-3 last:border-b-0"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 items-center justify-center rounded-full bg-muted text-body",
          error &&
            "bg-[var(--ap-tone-danger-bg)] text-[var(--ap-tone-danger-fg)]",
        )}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          {error ? (
            <path d="M12 7v6m0 4h.01" />
          ) : (
            <circle cx="12" cy="12" r="2" />
          )}
        </svg>
      </span>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-baseline gap-2 text-control font-medium">
          <span>{formatMessage(presentation.label)}</span>
          <span className="text-muted-foreground text-caption font-normal">
            <time dateTime={row.occurredAt}>
              {formatTimestamp(row.occurredAt, locale)}
            </time>
            {row.turnId ? ` · ${messages.turn(row.turnId)}` : null}
          </span>
        </div>
        {presentation.detail ? (
          <details className="min-w-0">
            <summary className={cn(summaryClass, "cursor-pointer")}>
              {summary}
            </summary>
            <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted px-2.5 py-2 font-mono text-caption [overflow-wrap:anywhere]">
              {presentation.detail}
            </p>
          </details>
        ) : (
          <span className={summaryClass}>{summary}</span>
        )}
      </div>
    </li>
  );
}
