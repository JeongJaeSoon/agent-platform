import type { TurnEventPart, TurnEventPresentation } from "@werft-ai/contracts";
import { cn, formatTimestamp, type TimestampLocale } from "@werft-ai/ui";
import {
  CircleDot,
  CircleX,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";

import { Sparkles } from "../console-icons.ts";
import { type FormatTurnMessage, turnSummaryText } from "./turn-text.ts";

export interface TimelineEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly turnId: string | null;
  /** presentTurnEvent's reading, with the tool call paired by the screen. */
  readonly presentation: TurnEventPresentation;
}

/** Who or what an event came from; each has its own icon. */
export type TimelineKind = "agent" | "tool" | "request" | "error" | "system";

export interface TimelineMessages {
  /** Names the list for screen readers. */
  readonly label: string;
  readonly empty: string;
  readonly connecting: string;
  readonly closed: string;
  readonly turn: (turnId: string) => string;
  /** Names each icon; without it the icons stay hidden from screen readers. */
  readonly kind?: ((kind: TimelineKind) => string) | undefined;
}

export function timelineKind(
  presentation: TurnEventPresentation,
): TimelineKind {
  if (presentation.error) return "error";
  switch (presentation.label.key) {
    case "session.event.kind.assistant":
    case "session.event.kind.thinking":
      return "agent";
    case "session.event.kind.toolUse":
    case "session.event.kind.toolResult":
      return "tool";
    case "session.event.kind.permission":
    case "session.event.kind.question":
      return "request";
    case "session.event.kind.error":
      return "error";
    default:
      return "system";
  }
}

// Console v4 `.ev .who`: the agent and its tools blue, what waits on a
// person and what failed amber, the rest neutral.
const AGENT_TONE =
  "bg-[var(--ap-tone-progress-bg)] text-[var(--ap-tone-progress-fg)]";
const WAIT_TONE =
  "bg-[var(--ap-tone-attention-bg)] text-[var(--ap-tone-attention-fg)]";
const KIND_TONE = {
  agent: AGENT_TONE,
  tool: AGENT_TONE,
  request: WAIT_TONE,
  error: WAIT_TONE,
  system: "bg-accent text-muted-foreground",
} as const satisfies Record<TimelineKind, string>;

const KIND_ICON = {
  agent: Sparkles,
  tool: LoaderCircle,
  request: Hourglass,
  error: CircleX,
  system: CircleDot,
} as const satisfies Record<TimelineKind, LucideIcon>;

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
        <output className="rounded-card bg-muted px-3 py-2 text-muted-foreground text-body">
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
  const kind = timelineKind(presentation);
  const kindName = messages.kind?.(kind);
  const Icon = KIND_ICON[kind];
  const summary = turnSummaryText(presentation.summary, formatMessage);
  const summaryClass = cn(
    "min-w-0 text-control leading-[1.5] [overflow-wrap:anywhere]",
    error && "text-destructive",
  );
  return (
    <li
      data-error={error || undefined}
      data-kind={kind}
      className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 border-b py-3 last:border-b-0"
    >
      <span
        {...(kindName
          ? { role: "img", "aria-label": kindName }
          : { "aria-hidden": true })}
        className={cn(
          "flex size-6 items-center justify-center rounded-full",
          KIND_TONE[kind],
        )}
      >
        <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-control font-medium">
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
            <p className="mt-1 whitespace-pre-wrap rounded-control border bg-muted px-3 py-2 font-mono text-caption leading-[1.6] [overflow-wrap:anywhere]">
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
