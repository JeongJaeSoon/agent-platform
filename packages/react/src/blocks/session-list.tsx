/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: static table rows delegate keyboard navigation to their cell links. */
import { Button, SessionRow, type SessionRowMessages } from "@werft-ai/ui";
import type { ReactNode } from "react";
import { useAgentPlatform } from "../provider.tsx";
import { useSessions } from "../sessions.ts";
import { useBlockText } from "./text.ts";

export interface SessionListProps {
  /** Shown until the first page arrives. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
}

/** The caller's own sessions, a page at a time; the API lists nobody else's. */
export function SessionList({ loading, renderError }: SessionListProps) {
  const { t, locale } = useBlockText();
  const { renderLink } = useAgentPlatform();
  const sessions = useSessions();
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];

  if (sessions.isPending) return loading;
  if (sessions.error && items.length === 0) {
    return renderError(sessions.error, () => void sessions.refetch());
  }
  if (items.length === 0) {
    return <p className="m-0 text-muted-foreground">{t("sessions.empty")}</p>;
  }

  const messages: SessionRowMessages = {
    status: (status) => t(`sessions.status.${status}`),
    admission: (state) => t(`sessions.admission.${state}`),
    statusAxis: t("sessions.column.status"),
    admissionAxis: t("sessions.column.admission"),
    runtime: t("sessions.column.runtime"),
    lastEvent: t("sessions.column.lastEvent"),
    created: t("sessions.column.created"),
    queuedTurns: (count) => `${t("session.queuedTurns")} ${count}`,
    none: t("sessions.none"),
  };
  return (
    <div className="flex flex-col items-start gap-3">
      <div
        role="table"
        aria-label={t("sessions.tableLabel")}
        className="@container m-0 w-full overflow-hidden rounded-lg border bg-card p-0"
      >
        <div
          role="row"
          className="grid min-h-9 grid-cols-[minmax(0,1fr)_120px] items-center gap-4 border-b bg-surface-sunken px-4 text-muted-foreground text-caption font-medium @[820px]:grid-cols-[minmax(0,2fr)_120px_120px_minmax(0,2fr)_minmax(72px,1fr)]"
        >
          <span role="columnheader">{t("sessions.column.id")}</span>
          <span role="columnheader">{t("sessions.column.status")}</span>
          <span role="columnheader" className="hidden @[820px]:block">
            {t("sessions.column.admission")}
          </span>
          <span role="columnheader" className="hidden @[820px]:block">
            {t("sessions.column.runtime")}
          </span>
          <span
            role="columnheader"
            className="hidden text-right @[820px]:block"
          >
            {t("sessions.column.lastEvent")} / {t("sessions.column.created")}
          </span>
        </div>
        {items.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            messages={messages}
            locale={locale}
            renderLink={(link) =>
              renderLink({ to: "session", id: session.id, ...link })
            }
          />
        ))}
      </div>
      {sessions.error
        ? renderError(
            sessions.error,
            () =>
              void (sessions.isFetchNextPageError
                ? sessions.fetchNextPage()
                : sessions.refetch()),
          )
        : null}
      {sessions.hasNextPage && !sessions.isFetchNextPageError ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={sessions.isFetchingNextPage}
          onClick={() => sessions.fetchNextPage()}
        >
          {sessions.isFetchingNextPage
            ? t("sessions.loadingMore")
            : t("sessions.more")}
        </Button>
      ) : null}
    </div>
  );
}
