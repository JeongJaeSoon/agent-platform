/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: static table rows delegate keyboard navigation to their cell links. */
import type { SessionStatus, SessionSummary } from "@werft-ai/contracts";
import { cn, RelativeTime, type TimestampLocale } from "@werft-ai/ui";
import { Folder } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { GitBranch } from "../console-icons.ts";
import { StatusLabel } from "../status/status-label.tsx";
import type { SessionRowLink } from "./session-row.tsx";
import { useMinute } from "./use-minute.ts";

/**
 * The console's session list columns, shared by the header and every row.
 * Up to 820px the repository gives its room to the title; the status and
 * time columns keep a fixed width throughout.
 */
export const SESSION_OVERVIEW_COLUMNS =
  "grid grid-cols-[minmax(0,2fr)_116px_minmax(0,1.2fr)_64px] @[820px]:grid-cols-[minmax(0,2.2fr)_120px_minmax(0,1fr)_minmax(0,1.4fr)_72px]";

const WIDE_ONLY = "hidden @[820px]:flex";

/** The id a person can tell rows apart by; the full id stays in the title. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

export interface SessionOverviewHeadMessages {
  readonly session: string;
  readonly status: string;
  readonly model: string;
  readonly repository: string;
  readonly recent: string;
}

export interface SessionOverviewTableProps {
  readonly label: string;
  readonly messages: SessionOverviewHeadMessages;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

export function SessionOverviewTable({
  label,
  messages,
  children,
  className,
}: SessionOverviewTableProps): JSX.Element {
  return (
    <div
      role="table"
      aria-label={label}
      className={cn(
        "@container m-0 flex w-full min-w-0 flex-col overflow-hidden rounded-card border bg-card p-0",
        className,
      )}
    >
      <div
        role="row"
        className={cn(
          SESSION_OVERVIEW_COLUMNS,
          "min-h-[var(--ap-row-head-min-height)] items-center gap-4 border-b bg-surface-sunken px-[var(--ap-row-padding-x)] py-[var(--ap-row-head-padding-y)] font-medium text-caption text-subtle-foreground",
        )}
      >
        {/* One line each: a narrow column cuts its name rather than wrap. */}
        <span role="columnheader" className="truncate">
          {messages.session}
        </span>
        <span role="columnheader" className="truncate">
          {messages.status}
        </span>
        <span role="columnheader" className="truncate">
          {messages.model}
        </span>
        <span role="columnheader" className={cn(WIDE_ONLY, "min-w-0")}>
          {messages.repository}
        </span>
        <span role="columnheader" className="truncate text-right">
          {messages.recent}
        </span>
      </div>
      {children}
    </div>
  );
}

export interface SessionOverviewRowMessages {
  readonly status: (status: SessionStatus) => string;
  /** The axis name a screen reader hears before the status. */
  readonly statusAxis: string;
  readonly noRepository: string;
  /** Stands in for a session without a runtime model. */
  readonly unknown: string;
  /** Heard before the time, which the row shows as a value only. */
  readonly recent: string;
}

export interface SessionOverviewRowProps {
  readonly session: SessionSummary;
  /** Owned by the screen that routes; this package never builds URLs. */
  readonly renderLink: (link: SessionRowLink) => ReactNode;
  readonly messages: SessionOverviewRowMessages;
  /** After the status, such as how long an answer has been awaited. */
  readonly statusDetail?: string | undefined;
  /**
   * Draws the last activity; when omitted, "12분 전" with the exact time in
   * a tooltip.
   */
  readonly renderTime?: ((iso: string) => ReactNode) | undefined;
  readonly locale?: TimestampLocale | undefined;
  /** The instant the default time counts from; a clock of its own if unset. */
  readonly now?: number | undefined;
  readonly className?: string | undefined;
}

export function SessionOverviewRow({
  session,
  renderLink,
  messages,
  statusDetail,
  renderTime,
  locale = "ko",
  now,
  className,
}: SessionOverviewRowProps): JSX.Element {
  const clock = useMinute(!renderTime && now === undefined);
  const shortId = shortSessionId(session.id);
  const at = session.last_event_at ?? session.created_at;
  // A server older than the repository field sends only the catalog key.
  const repositoryName = session.repository
    ? (session.repository.full_name ?? messages.unknown)
    : session.repository_id;
  const branch = session.repository?.branch;
  const RepositoryIcon = repositoryName ? GitBranch : Folder;
  return (
    <div
      role="row"
      data-slot="session-overview-row"
      data-status={session.status}
      className={cn(
        SESSION_OVERVIEW_COLUMNS,
        "relative min-h-[var(--ap-row-min-height)] min-w-0 items-center gap-4 border-b px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)] text-control last:border-b-0 hover:bg-(--ap-color-hover)",
        className,
      )}
    >
      <span role="cell" className="flex min-w-0 flex-col items-start gap-0.5">
        <span className="max-w-full truncate font-medium text-foreground leading-5">
          {renderLink({
            children: session.title ?? shortId,
            // Untitled, the row shows the id's head; the name keeps it whole.
            "aria-label": session.title ?? session.id,
            title: session.title ?? session.id,
            className: cn(
              "outline-none after:absolute after:inset-0 after:rounded-control hover:underline focus-visible:underline focus-visible:after:ring-2 focus-visible:after:ring-ring",
              session.title ? null : "font-mono",
            ),
          })}
        </span>
        {session.title ? (
          <span
            className="relative max-w-full truncate font-mono text-caption text-subtle-foreground leading-4"
            title={session.id}
          >
            {shortId}
          </span>
        ) : null}
      </span>
      <span role="cell" className="flex min-w-0">
        <StatusLabel
          appearance="dot"
          axis="session"
          state={session.status}
          label={messages.status(session.status)}
          axisLabel={messages.statusAxis}
          detail={statusDetail}
        />
      </span>
      <span
        role="cell"
        className="min-w-0 truncate font-mono text-caption text-muted-foreground"
      >
        {session.runtime?.model ?? messages.unknown}
      </span>
      <span role="cell" className={cn(WIDE_ONLY, "min-w-0 items-center gap-2")}>
        <RepositoryIcon
          className="size-3.5 flex-none text-subtle-foreground"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {repositoryName ? (
          // A long name gives way first, so the branch stays in sight.
          <span
            className="relative flex min-w-0 font-mono text-caption"
            title={branch ? `${repositoryName} · ${branch}` : repositoryName}
          >
            <span className="min-w-0 truncate">{repositoryName}</span>
            {branch ? (
              <span className="max-w-[50%] flex-none overflow-hidden text-ellipsis whitespace-pre">
                {` · ${branch}`}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="truncate text-caption text-subtle-foreground">
            {messages.noRepository}
          </span>
        )}
      </span>
      <span
        role="cell"
        className="flex min-w-0 justify-end overflow-hidden whitespace-nowrap text-caption text-subtle-foreground"
      >
        <span className="sr-only">{messages.recent} </span>
        {/* Above the row link's overlay, so hovering and focus reach the
            time. A longer word than the column ("yesterday 15:14") is cut,
            not spilled over the repository; the ring sits inside the cut. */}
        <span
          className={cn("relative min-w-0", renderTime ? "truncate" : "flex")}
        >
          {renderTime ? (
            renderTime(at)
          ) : (
            <RelativeTime
              value={at}
              locale={locale}
              now={now ?? clock}
              // Important: apps/web's unlayered focus rule sets a 2px offset.
              className="truncate focus-visible:-outline-offset-2!"
            />
          )}
        </span>
      </span>
    </div>
  );
}
