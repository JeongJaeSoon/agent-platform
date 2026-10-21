import type {
  AdmissionState,
  SessionStatus,
  SessionSummary,
} from "@agent-platform/contracts";
import type { JSX } from "react";

import { cn } from "../lib/cn.ts";
import { Badge } from "../primitives/badge.tsx";
import {
  formatTimestamp,
  type TimestampLocale,
} from "../receipt/format-timestamp.ts";

export interface SessionRowMessages {
  readonly status: (status: SessionStatus) => string;
  readonly admission: (state: AdmissionState) => string;
  readonly lastEvent: string;
  readonly created: string;
  readonly queuedTurns: (count: number) => string;
  /** Stands in for a value the session does not have, such as a runtime. */
  readonly none: string;
}

export interface SessionRowProps {
  readonly session: SessionSummary;
  /** Built by the screen that owns routing; this package never builds URLs. */
  readonly href: string;
  readonly messages: SessionRowMessages;
  readonly locale?: TimestampLocale | undefined;
  readonly className?: string | undefined;
}

/** Enough of a UUID to tell sessions apart in a narrow list. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

export function SessionRow({
  session,
  href,
  messages,
  locale = "ko",
  className,
}: SessionRowProps): JSX.Element {
  const { runtime } = session;
  const failed = session.status === "failed";
  return (
    <div
      data-slot="session-row"
      data-status={session.status}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border bg-card p-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4",
        className,
      )}
    >
      <a
        href={href}
        aria-label={session.id}
        title={session.id}
        className="rounded-sm font-medium font-mono underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {shortId(session.id)}
      </a>
      <span className="flex flex-wrap gap-2">
        <Badge
          variant={
            failed
              ? "destructive"
              : session.status === "needs_input"
                ? "default"
                : "secondary"
          }
        >
          {messages.status(session.status)}
        </Badge>
        <Badge variant="outline">
          {messages.admission(session.admission_state)}
        </Badge>
        {session.queued_turn_count > 0 ? (
          <Badge variant="outline">
            {messages.queuedTurns(session.queued_turn_count)}
          </Badge>
        ) : null}
      </span>
      <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere] sm:flex-1">
        {runtime
          ? `${runtime.profile_id} · ${runtime.kind} ${runtime.version}`
          : messages.none}
      </span>
      <span className="flex flex-col text-muted-foreground text-xs sm:items-end">
        <span>
          {messages.lastEvent}{" "}
          {session.last_event_at ? (
            <time dateTime={session.last_event_at}>
              {formatTimestamp(session.last_event_at, locale)}
            </time>
          ) : (
            messages.none
          )}
        </span>
        <span>
          {messages.created}{" "}
          <time dateTime={session.created_at}>
            {formatTimestamp(session.created_at, locale)}
          </time>
        </span>
      </span>
    </div>
  );
}
