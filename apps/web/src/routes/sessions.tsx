import { Link, useParams } from "@tanstack/react-router";
import { type ApiError, isApiError } from "../api/client.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import {
  usePendingRequests,
  useSession,
  useSessionEvents,
  useSessions,
  useSessionUsage,
} from "../sessions/hooks.ts";
import {
  PendingRequestList,
  SessionEventList,
  SessionOverview,
  SessionTable,
  SessionUsagePanel,
} from "../sessions/views.tsx";

function LoadError({ error }: { readonly error: unknown }) {
  const { t } = useI18n();
  if (isApiError(error, "FORBIDDEN")) {
    return <StatusScreen kind="forbidden" detail={error.message} />;
  }
  return (
    <p className="web-form__error" role="alert">
      {t(errorKey((error as ApiError).code))}
    </p>
  );
}

/** The caller's own sessions; the API lists nobody else's. */
export function SessionsScreen() {
  const { t } = useI18n();
  const sessions = useSessions();
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("sessions.title")}</h1>
      <p className="web-page__intro">{t("sessions.intro")}</p>
      {sessions.isPending ? (
        <StatusScreen kind="loading" />
      ) : sessions.error && items.length === 0 ? (
        <LoadError error={sessions.error} />
      ) : items.length === 0 ? (
        <p className="web-page__empty">{t("sessions.empty")}</p>
      ) : (
        <>
          <SessionTable sessions={items} />
          {sessions.error ? <LoadError error={sessions.error} /> : null}
          {sessions.hasNextPage ? (
            <button
              type="button"
              className="ap-button"
              disabled={sessions.isFetchingNextPage}
              onClick={() => sessions.fetchNextPage()}
            >
              {sessions.isFetchingNextPage
                ? t("sessions.loadingMore")
                : t("sessions.more")}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

export function SessionDetailScreen() {
  const { t } = useI18n();
  const { id } = useParams({ from: "/authed/sessions/$id" });
  const session = useSession(id);
  // The rest waits for the detail, so a session the caller may not read is
  // not asked about four times over. A failed refetch keeps the last detail,
  // so the stream stays open through it.
  const detail = session.data;
  const readable = detail !== undefined;
  const usage = useSessionUsage(id, readable);
  const pending = usePendingRequests(id, readable);
  const events = useSessionEvents(id, readable);

  return (
    <div className="web-page">
      <p>
        <Link to="/sessions">← {t("session.back")}</Link>
      </p>
      <h1 className="web-page__title">
        <code>{id}</code>
      </h1>
      {detail === undefined && session.isPending ? (
        <StatusScreen kind="loading" />
      ) : detail === undefined ? (
        isApiError(session.error, "NOT_FOUND") ? (
          <p className="web-form__error" role="alert">
            {t("session.notFound")}
          </p>
        ) : (
          <LoadError error={session.error} />
        )
      ) : (
        <>
          <SessionOverview session={detail} />
          {usage.data ? (
            <SessionUsagePanel usage={usage.data} />
          ) : usage.error ? (
            <LoadError error={usage.error} />
          ) : null}
          {pending.data ? (
            <PendingRequestList items={pending.data.items} />
          ) : pending.error ? (
            <LoadError error={pending.error} />
          ) : null}
          <SessionEventList events={events.events} state={events.state} />
        </>
      )}
    </div>
  );
}
