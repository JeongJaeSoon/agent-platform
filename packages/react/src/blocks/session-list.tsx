import { Button, SessionRow, type SessionRowMessages } from "@agent-platform/ui";
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
    lastEvent: t("sessions.column.lastEvent"),
    created: t("sessions.column.created"),
    queuedTurns: (count) => `${t("session.queuedTurns")} ${count}`,
    none: t("sessions.none"),
  };
  return (
    <div className="flex flex-col items-start gap-3">
      <ul
        aria-label={t("sessions.tableLabel")}
        className="m-0 flex w-full list-none flex-col gap-2 p-0"
      >
        {items.map((session) => (
          <li key={session.id}>
            <SessionRow
              session={session}
              messages={messages}
              locale={locale}
              renderLink={(link) =>
                renderLink({ to: "session", id: session.id, ...link })
              }
            />
          </li>
        ))}
      </ul>
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
