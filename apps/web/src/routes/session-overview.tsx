import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "@werft-ai/contracts";
import { usePendingRequests } from "@werft-ai/react";
import {
  SessionOverviewRow,
  SessionOverviewTable,
} from "@werft-ai/react/components";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n.tsx";

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
      now={now}
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
