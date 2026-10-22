import {
  Button,
  SessionRow,
  type SessionRowMessages,
  SessionTable,
} from "@werft-ai/ui";
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
      <SessionTable
        label={t("sessions.tableLabel")}
        messages={{
          id: t("sessions.column.id"),
          status: t("sessions.column.status"),
          admission: t("sessions.column.admission"),
          runtime: t("sessions.column.runtime"),
          lastEvent: t("sessions.column.lastEvent"),
          created: t("sessions.column.created"),
        }}
      >
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
      </SessionTable>
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
