import { isApiError } from "@agent-platform/client";
import type { SessionDetail as SessionDetailData } from "@agent-platform/contracts";
import { profilesQuery } from "@agent-platform/core";
import {
  useAgentPlatform,
  useChangeSessionProfile,
} from "@agent-platform/react";
import { SessionDetail, SessionList } from "@agent-platform/react/blocks";
import {
  buttonVariants,
  Field,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@agent-platform/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
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

function loadError(error: unknown, onRetry: () => void) {
  if (isApiError(error, "FORBIDDEN")) {
    return <StatusScreen kind="forbidden" />;
  }
  return <LoadFailure error={error} onRetry={onRetry} />;
}

const PAGE = "flex flex-col gap-6";
const TITLE = "m-0 font-semibold text-xl";

export function SessionsScreen() {
  const { t } = useI18n();
  return (
    <div className={PAGE}>
      <div className="flex flex-col gap-1">
        <h1 className={TITLE}>{t("sessions.title")}</h1>
        <p className="m-0 text-muted-foreground">{t("sessions.intro")}</p>
      </div>
      <SessionList
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
      />
    </div>
  );
}

export function SessionDetailScreen() {
  const { t } = useI18n();
  const { id } = useParams({ from: "/authed/sessions/$id" });
  return (
    <div className={PAGE}>
      <div className="flex flex-col gap-2">
        <p className="m-0">
          <Link
            to="/sessions"
            className="text-primary underline underline-offset-2"
          >
            ← {t("session.back")}
          </Link>
        </p>
        <h1 className={`${TITLE} [overflow-wrap:anywhere]`}>
          <code>{id}</code>
        </h1>
      </div>
      <SessionDetail
        id={id}
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
        controls={(session) => <SessionProfile session={session} />}
      />
    </div>
  );
}

/**
 * Moves the session onto another profile from its next turn on. Only profiles
 * that run the same runtime and bill the same way are offered; the server
 * decides the rest (the repository's catalog pairing, a release session) and
 * says why it refused.
 */
function SessionProfile({ session }: { readonly session: SessionDetailData }) {
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
              error.code === "UNSUPPORTED_CAPABILITY" ||
              error.code === "RELEASE_PROFILE_MISMATCH"
                ? `${t("session.profile.refused")} ${error.message}`
                : refusalText(t, error, "session.control", role),
          }),
      },
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby={titleId}>
      <h2 id={titleId} className="m-0 font-semibold text-lg">
        {t("session.profile")}
      </h2>
      <OutcomeLine outcome={outcome} />
      {profiles.isPending ? (
        <StatusScreen kind="loading" />
      ) : profiles.error ? (
        loadError(profiles.error, () => void profiles.refetch())
      ) : choices.length === 0 ? (
        <p className="m-0 text-muted-foreground text-sm">
          {current ? t("session.profile.none") : t("session.profile.unknown")}
        </p>
      ) : (
        <form className="flex flex-col items-start gap-3" onSubmit={submit}>
          <Field className="max-w-md">
            <FieldLabel>{t("session.profile.next")}</FieldLabel>
            <NativeSelect
              value={target}
              disabled={reason !== undefined}
              onChange={(event) => setPicked(event.target.value)}
            >
              {choices.map((profile) => (
                <NativeSelectOption key={profile.id} value={profile.id}>
                  {`${profile.id} · ${profile.model}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{t("session.profile.hint")}</FieldDescription>
          </Field>
          <ReasonButton
            type="submit"
            className={buttonVariants()}
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
