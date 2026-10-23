import type {
  TurnEventMessage,
  TurnEventPart,
  TurnEventPresentation,
} from "@werft-ai/contracts";
import {
  cn,
  formatRelativeTime,
  RelativeTime,
  type TimestampLocale,
} from "@werft-ai/ui";
import {
  ChevronRight,
  CircleDot,
  CircleX,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { type JSX, useId, useState } from "react";

import { Sparkles } from "../console-icons.ts";
import { type FormatTurnMessage, turnSummaryText } from "./turn-text.ts";

export interface TimelineEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly turnId: string | null;
  /** presentTurnEvent's reading, with the tool call paired by the screen. */
  readonly presentation: TurnEventPresentation;
  /**
   * The tool_use block's id, on the call and on its result alike; a result
   * with the id of an earlier call is drawn inside that call's row.
   */
  readonly toolCallId?: string | undefined;
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
  /**
   * Names a run of status and system lines folded into one; without it each
   * stays a compact line of its own.
   */
  readonly folded?: ((count: number) => string) | undefined;
  /** Marks a tool call whose result has not arrived. */
  readonly running?: string | undefined;
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
// person amber, the rest neutral. A failure stays red (lead decision C6),
// where v4 draws it amber.
const AGENT_TONE =
  "bg-[var(--ap-tone-progress-bg)] text-[var(--ap-tone-progress-fg)]";
const KIND_TONE = {
  agent: AGENT_TONE,
  tool: AGENT_TONE,
  request:
    "bg-[var(--ap-tone-attention-bg)] text-[var(--ap-tone-attention-fg)]",
  error: "bg-[var(--ap-tone-danger-bg)] text-[var(--ap-tone-danger-fg)]",
  system: "bg-active text-muted-foreground",
} as const satisfies Record<TimelineKind, string>;

const KIND_ICON = {
  agent: Sparkles,
  tool: LoaderCircle,
  request: Hourglass,
  error: CircleX,
  system: CircleDot,
} as const satisfies Record<TimelineKind, LucideIcon>;

// Status, system and internal lines: bookkeeping a reader skims past.
const NOISE_LABELS: ReadonlySet<TurnEventMessage["key"]> = new Set([
  "session.event.kind.status",
  "session.event.kind.system",
  "session.event.kind.internal",
]);

const STATE_ALONE = "px-4 py-6 text-center";
const ROW = "relative grid grid-cols-[24px_minmax(0,1fr)] gap-3 border-b";
const TIME = "text-caption font-normal text-subtle-foreground";
const FOCUS =
  "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export interface TimelineProps {
  readonly entries: readonly TimelineEntry[];
  readonly formatMessage: FormatTurnMessage;
  readonly messages: TimelineMessages;
  /** The event stream: `connecting` and `closed` say so above the list. */
  readonly state?: "connecting" | "open" | "closed" | undefined;
  /** Shows the events presentTurnEvent marks `fold: "debug"`. */
  readonly showDebug?: boolean | undefined;
  readonly locale?: TimestampLocale | undefined;
  /** The instant relative times count from; defaults to the clock. */
  readonly now?: number | Date | undefined;
  readonly className?: string | undefined;
}

interface TimelineRow extends TimelineEntry {
  readonly key: string;
  /** The tool result paired with this call, drawn in the same row. */
  readonly result?: TimelineEntry | undefined;
}

type TimelineItem =
  | { readonly fold: false; readonly row: TimelineRow }
  | {
      readonly fold: true;
      readonly key: string;
      readonly rows: readonly TimelineRow[];
    };

interface TurnGroup {
  readonly key: string;
  readonly turnId: string | null;
  readonly startedAt: string;
  readonly items: readonly TimelineItem[];
}

function withCount(
  summary: readonly TurnEventPart[],
  count: number,
): TurnEventPart[] {
  return summary.map((part) =>
    "key" in part ? { ...part, params: { ...part.params, count } } : part,
  );
}

const isNoise = (row: TimelineEntry): boolean =>
  !row.presentation.error && NOISE_LABELS.has(row.presentation.label.key);

function timelineRows(
  entries: readonly TimelineEntry[],
  showDebug: boolean,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const openCalls = new Map<string, number>();
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
    const callAt =
      entry.toolCallId === undefined
        ? undefined
        : openCalls.get(entry.toolCallId);
    const call = callAt === undefined ? undefined : rows[callAt];
    if (
      call &&
      callAt !== undefined &&
      presentation.label.key === "session.event.kind.toolResult"
    ) {
      rows[callAt] = { ...call, result: entry };
      openCalls.delete(entry.toolCallId as string);
      continue;
    }
    // Nothing to say: a row here would be an empty card.
    if (presentation.summary.length === 0) continue;
    if (
      entry.toolCallId !== undefined &&
      presentation.label.key === "session.event.kind.toolUse"
    ) {
      openCalls.set(entry.toolCallId, rows.length);
    }
    rows.push({ ...entry, key: entry.id });
  }
  return rows;
}

function turnGroups(rows: readonly TimelineRow[], fold: boolean): TurnGroup[] {
  const groups: { key: string; turnId: string | null; rows: TimelineRow[] }[] =
    [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (row.turnId !== null && last?.turnId === row.turnId) last.rows.push(row);
    else groups.push({ key: row.key, turnId: row.turnId, rows: [row] });
  }
  return groups.map((group) => {
    const items: TimelineItem[] = [];
    let run: TimelineRow[] = [];
    const flush = () => {
      const [first] = run;
      if (first && run.length > 1) {
        items.push({ fold: true, key: `fold-${first.key}`, rows: run });
      } else if (first) items.push({ fold: false, row: first });
      run = [];
    };
    for (const row of group.rows) {
      if (fold && isNoise(row)) {
        run.push(row);
        continue;
      }
      flush();
      items.push({ fold: false, row });
    }
    flush();
    return {
      key: group.key,
      turnId: group.turnId,
      startedAt: group.rows[0]?.occurredAt ?? "",
      items,
    };
  });
}

// The head's own key: the group's key is its first row's.
const headKey = (group: TurnGroup): string => `head-${group.key}`;

/** The turn's token count, read from its result event's summary. */
function turnTokens(group: TurnGroup): TurnEventMessage | undefined {
  for (const item of group.items) {
    if (item.fold) continue;
    const { presentation } = item.row;
    if (presentation.label.key !== "session.event.kind.result") continue;
    for (const part of presentation.summary) {
      if ("key" in part && part.key === "session.event.result.tokens") {
        return part;
      }
    }
  }
  return undefined;
}

interface TimeContext {
  readonly locale: TimestampLocale;
  readonly now: number | Date | undefined;
}

interface StampProps {
  readonly at: string;
  readonly time: TimeContext;
}

/** A relative time a keyboard can reach, its exact time in a tooltip. */
function Stamp({ at, time }: StampProps): JSX.Element {
  return (
    <RelativeTime
      value={at}
      locale={time.locale}
      {...(time.now === undefined ? {} : { now: time.now })}
      className={TIME}
    />
  );
}

/**
 * Where the line above already reads the same: unseen until it takes focus,
 * so keyboard and screen reader users still reach this row's exact time. It
 * sits inside the text it follows and takes no place of its own.
 */
function HiddenStamp({ at, time }: StampProps): JSX.Element {
  return (
    <>
      {" "}
      <RelativeTime
        value={at}
        locale={time.locale}
        {...(time.now === undefined ? {} : { now: time.now })}
        className={cn(TIME, "sr-only focus-visible:not-sr-only")}
      />
    </>
  );
}

/** The 1px line joining the icons above and below; `top` is the icon's. */
function Rail({
  top,
  bottom,
  first,
  last,
}: {
  readonly top: string;
  readonly bottom: string;
  readonly first: boolean;
  readonly last: boolean;
}): JSX.Element | null {
  if (first && last) return null;
  return (
    <>
      {first ? null : (
        <span
          aria-hidden="true"
          className={cn("absolute top-0 left-[11.5px] w-px bg-border", top)}
        />
      )}
      {last ? null : (
        <span
          aria-hidden="true"
          className={cn(
            "absolute bottom-0 left-[11.5px] w-px bg-border",
            bottom,
          )}
        />
      )}
    </>
  );
}

export function Timeline({
  entries,
  formatMessage,
  messages,
  state = "open",
  showDebug = false,
  locale = "ko",
  now,
  className,
}: TimelineProps): JSX.Element {
  const idBase = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const rows = timelineRows(entries, showDebug);
  const groups = turnGroups(rows, messages.folded !== undefined);
  const time: TimeContext = { locale, now };

  // A time that would read the same as the one above it is not repeated,
  // in reading order.
  const shown = new Set<string>();
  let said: string | undefined;
  const see = (key: string, at: string) => {
    const next = formatRelativeTime(at, locale, now);
    if (next !== said) shown.add(key);
    said = next;
  };
  for (const group of groups) {
    if (group.turnId !== null) see(headKey(group), group.startedAt);
    for (const item of group.items) {
      if (!item.fold) {
        see(item.row.key, item.row.occurredAt);
        continue;
      }
      // Folded lines may be out of sight, so the line after the fold
      // compares with what stood before it.
      const before = said;
      for (const row of item.rows) see(row.key, row.occurredAt);
      said = before;
    }
  }

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const renderItems = (items: readonly TimelineItem[]) => {
    // Each line knows whether the rail continues above and below it.
    const lines: {
      key: string;
      draw: (first: boolean, last: boolean) => JSX.Element;
    }[] = [];
    for (const item of items) {
      if (!item.fold) {
        const { row } = item;
        lines.push({
          key: row.key,
          draw: (first, last) =>
            isNoise(row) ? (
              <NoiseItem
                key={row.key}
                row={row}
                formatMessage={formatMessage}
                messages={messages}
                time={time}
                shown={shown.has(row.key)}
                first={first}
                last={last}
              />
            ) : (
              <EventItem
                key={row.key}
                row={row}
                formatMessage={formatMessage}
                messages={messages}
                time={time}
                shown={shown.has(row.key)}
                first={first}
                last={last}
              />
            ),
        });
        continue;
      }
      const expanded = open.has(item.key);
      lines.push({
        key: item.key,
        draw: (first, last) => (
          <FoldItem
            key={item.key}
            rows={item.rows}
            expanded={expanded}
            onToggle={() => toggle(item.key)}
            formatMessage={formatMessage}
            messages={messages}
            first={first}
            last={last}
          />
        ),
      });
      if (!expanded) continue;
      for (const row of item.rows) {
        lines.push({
          key: row.key,
          draw: (first, last) => (
            <NoiseItem
              key={row.key}
              row={row}
              formatMessage={formatMessage}
              messages={messages}
              time={time}
              shown={shown.has(row.key)}
              first={first}
              last={last}
            />
          ),
        });
      }
    }
    return lines.map((line, index) =>
      line.draw(index === 0, index === lines.length - 1),
    );
  };

  return (
    <div data-slot="timeline" className={cn("flex flex-col", className)}>
      {/* One layer inside the screen's card: alone, the line stands where
          the list would (console v4 `.empty.sm`); above rows, it is the
          first line of the list. */}
      {state === "open" ? null : (
        <output
          className={cn(
            "text-control text-muted-foreground",
            rows.length === 0 ? STATE_ALONE : "border-b py-3",
          )}
        >
          {state === "connecting" ? messages.connecting : messages.closed}
        </output>
      )}
      {rows.length === 0 ? (
        state === "open" ? (
          <p
            className={cn(
              "m-0 text-control text-muted-foreground",
              STATE_ALONE,
            )}
          >
            {messages.empty}
          </p>
        ) : null
      ) : (
        <ol aria-label={messages.label} className="flex flex-col">
          {groups.map((group, index) => {
            if (group.turnId === null) return renderItems(group.items);
            const headId = `${idBase}-turn-${index}`;
            const tokens = turnTokens(group);
            return (
              // biome-ignore lint/a11y/useSemanticElements: every <li> in the list stays one event, which the session screen's tests count
              <div
                key={group.key}
                role="listitem"
                data-slot="timeline-turn"
                className="border-b last:border-b-0"
              >
                <div
                  id={headId}
                  className="flex flex-wrap items-center gap-x-2 pt-4 text-caption"
                >
                  <span className="font-medium">
                    {messages.turn(group.turnId)}
                    {shown.has(headKey(group)) ? null : (
                      <HiddenStamp at={group.startedAt} time={time} />
                    )}
                  </span>
                  {shown.has(headKey(group)) ? (
                    <Stamp at={group.startedAt} time={time} />
                  ) : null}
                  {tokens ? (
                    <span className="text-subtle-foreground">
                      {formatMessage(tokens)}
                    </span>
                  ) : null}
                </div>
                <ol aria-labelledby={headId} className="flex flex-col">
                  {renderItems(group.items)}
                </ol>
              </div>
            );
          })}
        </ol>
      )}
    </div>
  );
}

interface LineProps {
  readonly formatMessage: FormatTurnMessage;
  readonly messages: TimelineMessages;
  readonly first: boolean;
  readonly last: boolean;
}

function KindIcon({
  kind,
  messages,
  small = false,
}: {
  readonly kind: TimelineKind;
  readonly messages: TimelineMessages;
  readonly small?: boolean;
}): JSX.Element {
  const kindName = messages.kind?.(kind);
  const Icon = KIND_ICON[kind];
  return (
    <span
      {...(kindName
        ? { role: "img", "aria-label": kindName }
        : { "aria-hidden": true })}
      className={cn(
        "relative flex items-center justify-center rounded-full",
        small ? "size-4 justify-self-center" : "size-6",
        KIND_TONE[kind],
      )}
    >
      <Icon size={small ? 10 : 14} strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

function Summary({
  entry,
  formatMessage,
}: {
  readonly entry: TimelineEntry;
  readonly formatMessage: FormatTurnMessage;
}): JSX.Element {
  const { presentation } = entry;
  const summary = turnSummaryText(presentation.summary, formatMessage);
  const summaryClass = cn(
    "min-w-0 text-control leading-[1.5] [overflow-wrap:anywhere]",
    presentation.error && "text-destructive",
  );
  if (!presentation.detail) {
    return <span className={summaryClass}>{summary}</span>;
  }
  return (
    <details className="min-w-0">
      <summary className={cn(summaryClass, "cursor-pointer")}>
        {summary}
      </summary>
      <p className="mt-1 whitespace-pre-wrap rounded-control border bg-muted px-3 py-2 font-mono text-caption leading-[1.6] [overflow-wrap:anywhere]">
        {presentation.detail}
      </p>
    </details>
  );
}

function EventItem({
  row,
  formatMessage,
  messages,
  time,
  shown,
  first,
  last,
}: LineProps & {
  readonly row: TimelineRow;
  readonly time: TimeContext;
  readonly shown: boolean;
}): JSX.Element {
  const { presentation, result } = row;
  const error =
    presentation.error === true || result?.presentation.error === true;
  const kind = error ? "error" : timelineKind(presentation);
  const running =
    row.toolCallId !== undefined &&
    result === undefined &&
    presentation.label.key === "session.event.kind.toolUse"
      ? messages.running
      : undefined;
  return (
    <li
      data-error={error || undefined}
      data-kind={kind}
      className={cn(ROW, "py-3 last:border-b-0")}
    >
      <Rail top="h-3" bottom="top-9" first={first} last={last} />
      <KindIcon kind={kind} messages={messages} />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-control font-medium">
          <span>
            {formatMessage(presentation.label)}
            {shown ? null : <HiddenStamp at={row.occurredAt} time={time} />}
          </span>
          {shown ? <Stamp at={row.occurredAt} time={time} /> : null}
          {running ? (
            <span className="text-caption font-normal text-[var(--ap-tone-progress-fg)]">
              {running}
            </span>
          ) : null}
        </div>
        <Summary entry={row} formatMessage={formatMessage} />
        {result ? (
          <Summary entry={result} formatMessage={formatMessage} />
        ) : null}
      </div>
    </li>
  );
}

function NoiseItem({
  row,
  formatMessage,
  messages,
  time,
  shown,
  first,
  last,
}: LineProps & {
  readonly row: TimelineRow;
  readonly time: TimeContext;
  readonly shown: boolean;
}): JSX.Element {
  const { presentation } = row;
  return (
    <li
      data-kind="system"
      data-noise="true"
      className={cn(ROW, "py-2 last:border-b-0")}
    >
      <Rail top="h-2" bottom="top-6" first={first} last={last} />
      <KindIcon kind="system" messages={messages} small={true} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption leading-4 text-muted-foreground">
        <span className="font-medium">{formatMessage(presentation.label)}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {turnSummaryText(presentation.summary, formatMessage)}
          {shown ? null : <HiddenStamp at={row.occurredAt} time={time} />}
        </span>
        {shown ? <Stamp at={row.occurredAt} time={time} /> : null}
      </div>
    </li>
  );
}

function FoldItem({
  rows,
  expanded,
  onToggle,
  formatMessage,
  messages,
  first,
  last,
}: LineProps & {
  readonly rows: readonly TimelineRow[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const labels = [
    ...new Set(rows.map((row) => formatMessage(row.presentation.label))),
  ];
  return (
    <li data-slot="timeline-fold" className={cn(ROW, "py-2 last:border-b-0")}>
      <Rail top="h-2" bottom="top-6" first={first} last={last} />
      <span
        aria-hidden="true"
        className={cn(
          "relative flex size-4 items-center justify-center justify-self-center rounded-full",
          KIND_TONE.system,
        )}
      >
        <ChevronRight
          size={10}
          strokeWidth={1.5}
          className={expanded ? "rotate-90" : undefined}
        />
      </span>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "min-w-0 cursor-pointer justify-self-start text-left text-caption leading-4 text-muted-foreground hover:text-foreground",
          FOCUS,
        )}
      >
        <span className="font-medium">{messages.folded?.(rows.length)}</span>
        {` · ${labels.join(", ")}`}
      </button>
    </li>
  );
}
