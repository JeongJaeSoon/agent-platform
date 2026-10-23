import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import type { SessionDetail as SessionDetailData } from "@werft-ai/contracts";
import { profilesQuery } from "@werft-ai/core";
import { useAgentPlatform, useChangeSessionProfile } from "@werft-ai/react";
import {
  ApprovalInbox,
  type SessionActionProps,
  SessionDetail,
  SessionList,
} from "@werft-ai/react/blocks";
import {
  buttonVariants,
  Field,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
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
import { Page } from "../components/page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

function loadError(error: unknown, onRetry: () => void) {
  if (isApiError(error, "FORBIDDEN")) {
    return <StatusScreen kind="forbidden" />;
  }
  return <LoadFailure error={error} onRetry={onRetry} />;
}

const PAGE = "flex flex-col gap-[var(--ap-space-section)]";

export function SessionsScreen() {
  const { t } = useI18n();
  const unavailable = useUnavailable();
  return (
    <Page title={t("sessions.title")} description={t("sessions.intro")}>
      <ApprovalInbox
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
        unavailable={unavailable}
        refusal={(error) => t(errorKey(error.code))}
      />
      <SessionList
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
      />
    </Page>
  );
}

/** Why the signed-in credential may not take each session action. */
function useUnavailable(): SessionActionProps["unavailable"] {
  const { t } = useI18n();
  const missing = (scope: string) => t("guard.missingScope", { scope });
  const canAnswer = useCan("sessions:approve");
  const canControl = useCan("sessions:control");
  const canSend = useCan("sessions:write");
  return {
    ...(canAnswer ? {} : { answer: missing("sessions:approve") }),
    ...(canControl ? {} : { control: missing("sessions:control") }),
    ...(canSend ? {} : { send: missing("sessions:write") }),
  };
}

export function SessionDetailScreen() {
  const { t } = useI18n();
  const { id } = useParams({ from: "/authed/sessions/$id" });
  const unavailable = useUnavailable();
  return (
    <div className={PAGE}>
      <SessionDetail
        back={
          <Link
            to="/sessions"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {t("session.back")}
          </Link>
        }
        id={id}
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
        controls={(session) => <SessionProfile session={session} />}
        unavailable={unavailable}
        refusal={(error) => t(errorKey(error.code))}
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
    <section
      className="flex flex-col gap-[var(--ap-space-block)]"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="m-0 font-semibold text-body">
        {t("session.profile")}
      </h2>
      <OutcomeLine outcome={outcome} />
      {profiles.isPending ? (
        <StatusScreen kind="loading" />
      ) : profiles.error ? (
        loadError(profiles.error, () => void profiles.refetch())
      ) : choices.length === 0 ? (
        <p className="m-0 text-muted-foreground text-body">
          {current ? t("session.profile.none") : t("session.profile.unknown")}
        </p>
      ) : (
        <form className="flex flex-col items-start gap-3" onSubmit={submit}>
          <Field className="w-full [&_[data-slot=native-select-wrapper]]:w-full">
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
