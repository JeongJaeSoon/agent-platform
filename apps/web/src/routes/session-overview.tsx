import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "@werft-ai/contracts";
import { usePendingRequests } from "@werft-ai/react";
import {
  SessionOverviewRow,
  SessionOverviewTable,
} from "@werft-ai/react/components";
import { formatTimestamp } from "@werft-ai/ui";
import { useEffect, useState } from "react";
import { type Locale, useI18n } from "../i18n/i18n.tsx";

const MINUTE_MS = 60_000;

/** Moves on every minute, so waits and short times do not stay as drawn. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Title or id prefix, as the design's search box matches. */
export function matchesSessionQuery(session: SessionSummary, query: string) {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    (session.title?.toLowerCase().includes(q) ?? false) ||
    session.id.toLowerCase().startsWith(q)
  );
}

export function SessionsOverview({
  sessions,
}: {
  readonly sessions: readonly SessionSummary[];
}) {
  const { t } = useI18n();
  const now = useMinute();
  return (
    <SessionOverviewTable
      label={t("sessions.tableLabel")}
      messages={{
        session: t("sessionList.column.session"),
        status: t("sessionList.column.status"),
        model: t("sessionList.column.model"),
        repository: t("sessionList.column.repository"),
        recent: t("sessionList.column.recent"),
      }}
    >
      {sessions.map((session) => (
        <Row key={session.id} session={session} now={now} />
      ))}
    </SessionOverviewTable>
  );
}

function Row({
  session,
  now,
}: {
  readonly session: SessionSummary;
  readonly now: number;
}) {
  const { t, locale } = useI18n();
  // "답변 대기 · 12분" reads the oldest open request, the inbox's own read.
  const waiting = session.status === "needs_input";
  const pending = usePendingRequests(session.id, waiting);
  const since = pending.data?.items
    .map((item) => item.created_at)
    .sort()
    .at(0);
  return (
    <SessionOverviewRow
      session={session}
      locale={locale}
      statusDetail={
        waiting && since
          ? t("sessionList.waitedMinutes", {
              minutes: minutesSince(since, now),
            })
          : undefined
      }
      messages={{
        status: (status) => t(`sessions.status.${status}`),
        statusAxis: t("sessions.column.status"),
        noRepository: t("sessionList.noRepository"),
        unknown: t("sessionList.unknown"),
        recent: t("sessionList.column.recent"),
      }}
      // The exact time rides in the title until RelativeTime and Tooltip land.
      renderTime={(at) => (
        <time dateTime={at} title={formatTimestamp(at, locale)}>
          {shortTime(at, locale, now)}
        </time>
      )}
      renderLink={({ children, ...link }) => (
        <Link to="/sessions/$id" params={{ id: session.id }} {...link}>
          {children}
        </Link>
      )}
    />
  );
}

function minutesSince(iso: string, now: number) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / MINUTE_MS));
}

/**
 * The design's short times: "12분 전" today, "어제 15:14", then "10/20".
 * Gives way to the ui-kit's RelativeTime, which home will share.
 */
export function shortTime(iso: string, locale: Locale, nowMs: number) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const now = new Date(nowMs);
  const minutes = Math.floor((nowMs - at.getTime()) / MINUTE_MS);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const relative = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "narrow",
  });
  if (at >= startOfToday) {
    if (minutes < 1) return relative.format(0, "second");
    if (minutes < 60) return relative.format(-minutes, "minute");
    return relative.format(-Math.floor(minutes / 60), "hour");
  }
  if (at >= startOfYesterday) {
    const clock = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
    return `${relative.format(-1, "day")} ${clock}`;
  }
  return at.getFullYear() === now.getFullYear()
    ? `${at.getMonth() + 1}/${at.getDate()}`
    : `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`;
}
