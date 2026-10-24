import type { SessionStatus, SessionSummary } from "@werft-ai/contracts";
import {
  cn,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  RelativeTime,
  StatusDot,
  type StatusDotStatus,
  type TimestampLocale,
} from "@werft-ai/ui";
import { Folder } from "lucide-react";
import { createContext, type JSX, type ReactNode, useContext } from "react";
import { GitBranch } from "../console-icons.ts";
import type { SessionRowLink } from "./session-row.tsx";
import { useMinute } from "./use-minute.ts";

/**
 * Console v4 `.t-sess`: title, status, agent · model, repository, started
 * by, recent. At 820px of table width and below, repository and started by
 * drop out for SESSION_OVERVIEW_NARROW_COLUMNS.
 */
export const SESSION_OVERVIEW_COLUMNS =
  "minmax(0,2.2fr) 120px minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1fr) 72px";
/** v4 `.t-sess-home`: the same without the started-by column. */
export const SESSION_OVERVIEW_HOME_COLUMNS =
  "minmax(0,2.2fr) 120px minmax(0,1.2fr) minmax(0,1.2fr) 72px";
export const SESSION_OVERVIEW_NARROW_COLUMNS =
  "minmax(0,2fr) 116px minmax(0,1.2fr) 64px";

/** The id a person can tell rows apart by; the full id stays in the title. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

export interface SessionOverviewHeadMessages {
  readonly session: string;
  readonly status: string;
  /** The third column's name when `agent` is not given. */
  readonly model: string;
  /** The third column's name, which holds the agent over its model. */
  readonly agent?: string | undefined;
  readonly repository: string;
  /** Given, the table has the started-by column (v4 `.t-sess`). */
  readonly startedBy?: string | undefined;
  readonly recent: string;
}

/** Whether the rows draw the started-by column; the table decides. */
const StartedByColumn = createContext(false);

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
  const startedBy = messages.startedBy !== undefined;
  return (
    // The row opener's focus ring sits outside the row, so this frame must
    // not clip overflow.
    <div
      className={cn("w-full min-w-0 rounded-card border bg-card", className)}
    >
      <GridTable
        aria-label={label}
        columns={
          startedBy ? SESSION_OVERVIEW_COLUMNS : SESSION_OVERVIEW_HOME_COLUMNS
        }
        narrowAt={820}
        narrowColumns={SESSION_OVERVIEW_NARROW_COLUMNS}
      >
        <GridTableHeader>
          {/* One line each: a narrow column cuts its name rather than wrap. */}
          <GridTableColumnHeader>
            <span className="truncate">{messages.session}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.status}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            <span className="truncate">{messages.agent ?? messages.model}</span>
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            <span className="truncate">{messages.repository}</span>
          </GridTableColumnHeader>
          {startedBy ? (
            <GridTableColumnHeader hideNarrow={true}>
              <span className="truncate">{messages.startedBy}</span>
            </GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader align="end">
            <span className="truncate">{messages.recent}</span>
          </GridTableColumnHeader>
        </GridTableHeader>
        <StartedByColumn.Provider value={startedBy}>
          {children}
        </StartedByColumn.Provider>
      </GridTable>
    </div>
  );
}

export interface SessionOverviewRowMessages {
  readonly status: (status: SessionStatus) => string;
  /** The axis name a screen reader hears before the status. */
  readonly statusAxis: string;
  readonly noRepository: string;
  /** Stands in for a value the session does not have: agent, model, starter. */
  readonly unknown: string;
  /** Heard before the time, which the row shows as a value only. */
  readonly recent: string;
  /** Names the row's opener, e.g. "세션 열기: 배포 점검"; the name alone if unset. */
  readonly open?: ((name: string) => string) | undefined;
}

export interface SessionOverviewRowProps {
  readonly session: SessionSummary;
  /**
   * Owned by the screen that routes; this package never builds URLs. The
   * link it returns is the row's opener, so it must be one element.
   */
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

const STATUS_DOT: Record<SessionStatus, StatusDotStatus> = {
  queued: "idle",
  running: "run",
  needs_input: "wait",
  idle: "idle",
  failed: "failed",
  stopped: "done",
};

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
  const startedBy = useContext(StartedByColumn);
  const clock = useMinute(!renderTime && now === undefined);
  const shortId = shortSessionId(session.id);
  // Untitled, the row shows the id's head; the opener's name keeps it whole.
  const name = session.title ?? session.id;
  const at = session.last_event_at ?? session.created_at;
  // A server older than the repository field sends only the catalog key.
  const repositoryName = session.repository
    ? (session.repository.full_name ?? messages.unknown)
    : session.repository_id;
  const branch = session.repository?.branch;
  const RepositoryIcon = repositoryName ? GitBranch : Folder;
  const statusLabel = messages.status(session.status);
  return (
    <GridTableRow
      data-slot="session-overview-row"
      data-status={session.status}
      className={className}
    >
      <GridTableCell lines={true}>
        <GridTableRowOpener
          aria-label={messages.open ? messages.open(name) : name}
          asChild={true}
        >
          {
            renderLink({
              children: null,
              "aria-label": messages.open ? messages.open(name) : name,
              // The opener covers the row, so its hover text is the one shown.
              title: name,
              className: "",
            }) as JSX.Element
          }
        </GridTableRowOpener>
        <span
          className={cn(
            "max-w-full truncate font-medium text-foreground",
            session.title ? null : "font-mono",
          )}
        >
          {session.title ?? shortId}
        </span>
        {session.title ? (
          <span className="font-mono text-caption text-subtle-foreground">
            {shortId}
          </span>
        ) : null}
      </GridTableCell>
      <GridTableCell>
        <StatusDot status={STATUS_DOT[session.status]} />
        <span className="sr-only">{messages.statusAxis}: </span>
        {/* A narrow column cuts the label, never the wait after it. */}
        <span className="flex min-w-0 whitespace-nowrap">
          <span className="min-w-0 truncate">{statusLabel}</span>
          {statusDetail ? (
            <span className="flex-none whitespace-pre"> · {statusDetail}</span>
          ) : null}
        </span>
      </GridTableCell>
      <GridTableCell lines={true}>
        <span className="max-w-full truncate">
          {session.agent?.name ?? messages.unknown}
        </span>
        {session.model ? (
          <span className="font-mono text-caption text-subtle-foreground">
            {session.model}
          </span>
        ) : null}
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <RepositoryIcon
          className="size-3.5 flex-none text-subtle-foreground"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {repositoryName ? (
          // A long name gives way first, so the branch stays in sight. Above
          // the opener, so hovering shows the whole name.
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
      </GridTableCell>
      {startedBy ? (
        <GridTableCell hideNarrow={true}>
          <span className="truncate">
            {session.created_by?.display_name || messages.unknown}
          </span>
        </GridTableCell>
      ) : null}
      <GridTableCell
        align="end"
        className="overflow-hidden whitespace-nowrap text-caption text-subtle-foreground"
      >
        <span className="sr-only">{messages.recent} </span>
        {/* Above the opener, so hovering and focus reach the time. A longer
            word than the column ("yesterday 15:14") is cut, not spilled over
            the next column; the ring sits inside the cut. */}
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
      </GridTableCell>
    </GridTableRow>
  );
}
