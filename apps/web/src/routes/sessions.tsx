import type { SessionDetail } from "@agent-platform/contracts";
import { useAgentPlatform } from "@agent-platform/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { isApiError } from "../api/client.ts";
import { profilesQuery } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  refusalText,
  useCan,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  useChangeSessionProfile,
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

function LoadError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  if (isApiError(error, "FORBIDDEN")) {
    return <StatusScreen kind="forbidden" />;
  }
  return <LoadFailure error={error} onRetry={onRetry} />;
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
        <LoadError
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="web-page__empty">{t("sessions.empty")}</p>
      ) : (
        <>
          <SessionTable sessions={items} />
          {sessions.error ? (
            <LoadError
              error={sessions.error}
              onRetry={() =>
                void (sessions.isFetchNextPageError
                  ? sessions.fetchNextPage()
                  : sessions.refetch())
              }
            />
          ) : null}
          {sessions.hasNextPage && !sessions.isFetchNextPageError ? (
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
  // not asked about four times over. A refetch that failed on the network
  // keeps the last detail and the stream; one that says the caller may no
  // longer see the session (a share taken back) drops both.
  const lostAccess =
    isApiError(session.error, "NOT_FOUND") ||
    isApiError(session.error, "FORBIDDEN");
  const detail = lostAccess ? undefined : session.data;
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
          <LoadError
            error={session.error}
            onRetry={() => void session.refetch()}
          />
        )
      ) : (
        <>
          <SessionOverview session={detail} />
          <SessionProfile session={detail} />
          {usage.data ? (
            <SessionUsagePanel usage={usage.data} />
          ) : usage.error ? (
            <LoadError
              error={usage.error}
              onRetry={() => void usage.refetch()}
            />
          ) : null}
          {pending.data ? (
            <PendingRequestList items={pending.data.items} />
          ) : pending.error ? (
            <LoadError
              error={pending.error}
              onRetry={() => void pending.refetch()}
            />
          ) : null}
          <SessionEventList events={events.events} state={events.state} />
        </>
      )}
    </div>
  );
}

/**
 * Moves the session onto another profile from its next turn on. Only profiles
 * that run the same runtime and bill the same way are offered; the server
 * decides the rest (the repository's catalog pairing, a release session) and
 * says why it refused.
 */
function SessionProfile({ session }: { readonly session: SessionDetail }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const titleId = useId();
  const profiles = useQuery(profilesQuery(client));
  const change = useChangeSessionProfile(session.id);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const reason = useCan("sessions:control")
    ? undefined
    : permissionReason(t, "session.control", role);

  const { runtime } = session;
  if (!runtime) return null;
  const items = profiles.data?.items ?? [];
  const current = items.find((profile) => profile.id === runtime.profile_id);
  const choices = current
    ? items.filter(
        (profile) =>
          profile.id !== current.id &&
          profile.runtime_kind === current.runtime_kind &&
          profile.runtime_version === current.runtime_version &&
          profile.billing === current.billing,
      )
    : [];
  const target =
    picked !== null && choices.some((profile) => profile.id === picked)
      ? picked
      : (choices[0]?.id ?? "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setOutcome(null);
    change.mutate(
      { expected_revision: session.revision, profile_id: target },
      {
        onSuccess: () =>
          setOutcome({
            kind: "notice",
            text: t("session.profile.changed", { profile: target }),
          }),
        onError: (error) =>
          setOutcome({
            kind: "error",
            text:
              error.code === "RELEASE_PROFILE_MISMATCH"
                ? t("session.profile.refused.release")
                : error.code === "UNSUPPORTED_CAPABILITY"
                  ? t("session.profile.refused.capability")
                  : refusalText(t, error, "session.control", role),
          }),
      },
    );
  };

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("session.profile")}</h2>
      <OutcomeLine outcome={outcome} />
      {profiles.isPending ? (
        <StatusScreen kind="loading" />
      ) : profiles.error ? (
        <LoadError
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      ) : choices.length === 0 ? (
        <p className="web-page__empty">
          {current ? t("session.profile.none") : t("session.profile.unknown")}
        </p>
      ) : (
        <form className="web-form" onSubmit={submit}>
          <label className="web-field">
            <span>{t("session.profile.next")}</span>
            <select
              className="ap-input"
              value={target}
              disabled={reason !== undefined}
              onChange={(event) => setPicked(event.target.value)}
            >
              {choices.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {`${profile.id} · ${profile.model}`}
                </option>
              ))}
            </select>
          </label>
          <p className="web-field__hint">{t("session.profile.hint")}</p>
          <ReasonButton
            type="submit"
            className="ap-button ap-button--primary"
            reason={reason}
            disabled={change.isPending}
          >
            {t("session.profile.submit")}
          </ReasonButton>
        </form>
      )}
    </section>
  );
}
