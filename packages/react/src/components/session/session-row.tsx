import type {
  AdmissionState,
  SessionStatus,
  SessionSummary,
} from "@werft-ai/contracts";
import {
  GridTableCell,
  GridTableRow,
  GridTableRowOpener,
  RelativeTime,
  type TimestampLocale,
} from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import { StatusLabel } from "../status/status-label.tsx";
import { SessionStatusLabel } from "./session-status-label.tsx";
import { useMinute } from "./use-minute.ts";

/**
 * SessionTable's column template. The state columns fit their longest label
 * on one line: "Waiting for an answer" and "Needs recovery" in English. At
 * 820px of table width and below, admission and runtime drop out for
 * SESSION_NARROW_COLUMNS, where a long status label wraps.
 */
export const SESSION_COLUMNS =
  "minmax(0,5fr) 160px 136px minmax(0,3fr) minmax(120px,2fr)";
export const SESSION_NARROW_COLUMNS = "minmax(0,1fr) 120px 72px";

export interface SessionRowMessages {
  readonly status: (status: SessionStatus) => string;
  readonly admission: (state: AdmissionState) => string;
  /** The axis names a screen reader hears before each state. */
  readonly statusAxis: string;
  readonly admissionAxis: string;
  /** Heard before the runtime; the row shows only its value. */
  readonly runtime: string;
  readonly lastEvent: string;
  readonly created: string;
  readonly queuedTurns: (count: number) => string;
  /** Stands in for a value the session does not have, such as a runtime. */
  readonly none: string;
}

/** What the row's link carries; the screen draws it with its router. */
export interface SessionRowLink {
  readonly children: ReactNode;
  readonly className: string;
  readonly "aria-label": string;
  readonly title: string;
}

export interface SessionRowProps {
  readonly session: SessionSummary;
  /** Owned by the screen that routes; this package never builds URLs. */
  readonly renderLink: (link: SessionRowLink) => ReactNode;
  readonly messages: SessionRowMessages;
  readonly locale?: TimestampLocale | undefined;
  /** The instant "N분 전" counts from; a clock of its own if unset. */
  readonly now?: number | undefined;
  readonly className?: string | undefined;
}

export function SessionRow({
  session,
  renderLink,
  messages,
  locale = "ko",
  now,
  className,
}: SessionRowProps): JSX.Element {
  const clock = useMinute(now === undefined);
  const { runtime } = session;
  return (
    <GridTableRow
      data-slot="session-row"
      data-status={session.status}
      className={className}
    >
      <GridTableCell className="font-mono text-caption">
        <GridTableRowOpener aria-label={session.id} asChild={true}>
          {
            renderLink({
              children: null,
              "aria-label": session.id,
              title: session.id,
              className: "",
            }) as JSX.Element
          }
        </GridTableRowOpener>
        <span className="min-w-0 truncate">{session.id}</span>
      </GridTableCell>
      {/* flex, not a line box: an inline badge would sit on the baseline and
          make the row 1–2px taller than its padding says. */}
      <GridTableCell>
        <SessionStatusLabel
          status={session.status}
          label={messages.status(session.status)}
          axisLabel={messages.statusAxis}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <StatusLabel
          className="whitespace-nowrap"
          axis="admission"
          state={session.admission_state}
          label={messages.admission(session.admission_state)}
          axisLabel={messages.admissionAxis}
        />
      </GridTableCell>
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        <span className="min-w-0 truncate">
          <span className="sr-only">{messages.runtime}: </span>
          {runtime
            ? `${runtime.profile_id} · ${runtime.kind} ${runtime.version}`
            : messages.none}
          {session.queued_turn_count > 0
            ? ` · ${messages.queuedTurns(session.queued_turn_count)}`
            : null}
        </span>
      </GridTableCell>
      <GridTableCell
        align="end"
        className="overflow-hidden whitespace-nowrap text-caption text-muted-foreground"
      >
        <span className="sr-only">
          {session.last_event_at ? messages.lastEvent : messages.created}{" "}
        </span>
        {/* Above the row's opener, so hovering and focus reach it. */}
        <RelativeTime
          value={session.last_event_at ?? session.created_at}
          locale={locale}
          now={now ?? clock}
          // The cell cuts what overflows; the ring stays inside.
          // Important: apps/web's unlayered focus rule sets a 2px offset.
          className="relative truncate focus-visible:-outline-offset-2!"
        />
      </GridTableCell>
    </GridTableRow>
  );
}
