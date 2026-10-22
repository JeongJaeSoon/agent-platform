/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: static table rows delegate keyboard navigation to their cell links. */
import type {
  AdmissionState,
  SessionStatus,
  SessionSummary,
} from "@werft-ai/contracts";
import type { JSX, ReactNode } from "react";

import { cn } from "../lib/cn.ts";
import {
  formatTimestamp,
  type TimestampLocale,
} from "../receipt/format-timestamp.ts";
import { StatusLabel } from "../status/status-label.tsx";
import { SessionStatusLabel } from "./session-status-label.tsx";

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
  readonly className?: string | undefined;
}

export function SessionRow({
  session,
  renderLink,
  messages,
  locale = "ko",
  className,
}: SessionRowProps): JSX.Element {
  const { runtime } = session;
  const timestamp = (
    <>
      <span className="sr-only">
        {session.last_event_at ? messages.lastEvent : messages.created}{" "}
      </span>
      <time dateTime={session.last_event_at ?? session.created_at}>
        {formatTimestamp(session.last_event_at ?? session.created_at, locale)}
      </time>
    </>
  );
  return (
    <div
      role="row"
      data-slot="session-row"
      data-status={session.status}
      className={cn(
        "relative grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)_120px] @[480px]:grid-cols-[minmax(0,1fr)_120px_136px] items-center gap-4 border-b px-4 py-2 text-control last:border-b-0 @[820px]:grid-cols-[minmax(0,2fr)_120px_120px_minmax(0,2fr)_minmax(72px,1fr)]",
        className,
      )}
    >
      <span role="cell" className="min-w-0 truncate font-mono text-caption">
        {renderLink({
          children: session.id,
          "aria-label": session.id,
          title: session.id,
          className:
            "after:absolute after:inset-0 after:rounded-sm outline-none hover:underline focus-visible:underline focus-visible:after:ring-2 focus-visible:after:ring-ring",
        })}
        <span className="mt-1 block text-left font-sans text-muted-foreground text-caption @[480px]:hidden">
          {timestamp}
        </span>
      </span>
      <span role="cell">
        <SessionStatusLabel
          status={session.status}
          label={messages.status(session.status)}
          axisLabel={messages.statusAxis}
        />
      </span>
      <span role="cell" className="hidden @[820px]:block">
        <StatusLabel
          axis="admission"
          state={session.admission_state}
          label={messages.admission(session.admission_state)}
          axisLabel={messages.admissionAxis}
        />
      </span>
      <span
        role="cell"
        className="hidden min-w-0 truncate text-muted-foreground @[820px]:block"
      >
        <span className="sr-only">{messages.runtime}: </span>
        {runtime
          ? `${runtime.profile_id} · ${runtime.kind} ${runtime.version}`
          : messages.none}
        {session.queued_turn_count > 0
          ? ` · ${messages.queuedTurns(session.queued_turn_count)}`
          : null}
      </span>
      <span
        role="cell"
        className="hidden text-right text-muted-foreground text-caption @[480px]:block"
      >
        {timestamp}
      </span>
    </div>
  );
}
