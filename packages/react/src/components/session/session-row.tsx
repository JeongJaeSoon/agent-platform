/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: static table rows delegate keyboard navigation to their cell links. */
import type {
  AdmissionState,
  SessionStatus,
  SessionSummary,
} from "@werft-ai/contracts";
import { cn, RelativeTime, type TimestampLocale } from "@werft-ai/ui";
import type { JSX, ReactNode } from "react";

import { StatusLabel } from "../status/status-label.tsx";
import { SessionStatusLabel } from "./session-status-label.tsx";

/**
 * Shared by the header row and every session row, which are separate grids.
 * From 480px the state columns fit their longest label on one line: "Waiting
 * for an answer" and "Needs recovery" in English. Narrower, the id needs the
 * room more and a long label wraps.
 */
export const SESSION_COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_120px] @[480px]:grid-cols-[minmax(0,1fr)_160px_136px] @[820px]:grid-cols-[minmax(0,5fr)_160px_136px_minmax(0,3fr)_minmax(120px,2fr)]";

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
      {/* Above the row link's overlay, so hovering and focus reach it. */}
      <RelativeTime
        value={session.last_event_at ?? session.created_at}
        locale={locale}
        // The narrow layout's cell cuts what overflows; the ring stays inside.
        // Important: apps/web's unlayered focus rule sets a 2px offset.
        className="relative focus-visible:-outline-offset-2!"
      />
    </>
  );
  return (
    <div
      role="row"
      data-slot="session-row"
      data-status={session.status}
      className={cn(
        SESSION_COLUMNS,
        "relative min-h-[var(--ap-row-min-height)] min-w-0 items-center gap-4 border-b px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)] text-control last:border-b-0",
        className,
      )}
    >
      <span
        role="cell"
        className="min-w-0 truncate font-mono text-caption leading-5"
      >
        {renderLink({
          children: session.id,
          "aria-label": session.id,
          title: session.id,
          className:
            "after:absolute after:inset-0 after:rounded-control outline-none hover:underline focus-visible:underline focus-visible:after:ring-2 focus-visible:after:ring-ring",
        })}
        <span className="mt-[var(--ap-row-line-gap)] block text-left font-sans text-caption text-muted-foreground leading-4 @[480px]:hidden">
          {timestamp}
        </span>
      </span>
      {/* flex, not a line box: an inline badge would sit on the baseline and
          make the row 1–2px taller than its padding says. */}
      <span role="cell" className="flex">
        <SessionStatusLabel
          className="@[480px]:whitespace-nowrap"
          status={session.status}
          label={messages.status(session.status)}
          axisLabel={messages.statusAxis}
        />
      </span>
      <span role="cell" className="hidden @[820px]:flex">
        <StatusLabel
          className="whitespace-nowrap"
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
