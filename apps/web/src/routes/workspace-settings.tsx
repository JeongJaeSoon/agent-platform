import type {
  AuditRetentionRequest,
  SlackGuestRequest,
} from "@agent-platform/contracts";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { type ApiError, unwrap } from "../api/client.ts";
import { queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

/** Workspace-wide settings an owner or admin opens from the menu. */
export function WorkspaceSettingsScreen() {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const workspaceManage = useHasPermission("workspace.manage");
  const retentionManage = useHasPermission("audit_retention.manage");
  if (!workspaceManage && !retentionManage) return <ReadOnlySettings />;
  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("workspace.title")}</h1>
      <OutcomeLine outcome={outcome} />
      <AuditRetention onOutcome={setOutcome} />
      <SlackGuest onOutcome={setOutcome} />
    </div>
  );
}

/** The settings as they stand, for someone who may change none of them. */
function ReadOnlySettings() {
  const { t } = useI18n();
  const settings = useMe()?.workspace?.settings;
  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("workspace.title")}</h1>
      <p className="web-page__intro">{t("workspace.readOnly")}</p>
      <section className="web-section">
        <h2>{t("workspace.retention")}</h2>
        <p>
          {settings
            ? t("workspace.retentionValue", {
                days: settings.audit_retention_days,
              })
            : "—"}
        </p>
      </section>
      <section className="web-section">
        <h2>{t("workspace.guest")}</h2>
        <p>
          {t(
            settings?.slack_guest_enabled
              ? "workspace.guestValueOn"
              : "workspace.guestValueOff",
          )}
        </p>
      </section>
    </div>
  );
}

/**
 * How long refused and allowed decisions are kept. Only an owner changes it;
 * the floor is the server's, so a short value goes there and comes back as
 * the refusal.
 */
function AuditRetention({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const current = me?.workspace?.settings.audit_retention_days;
  // Untouched, the field follows the server's value as it refreshes.
  const [draft, setDraft] = useState<string | null>(null);
  const days = draft ?? (current === undefined ? "" : `${current}`);
  const titleId = useId();
  const hintId = useId();
  const reason = useHasPermission("audit_retention.manage")
    ? undefined
    : permissionReason(t, "audit_retention.manage", role);

  const save = useMutation<AuditRetentionRequest, ApiError, number>({
    mutationFn: (value) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/audit-retention", {
          params: { path: { id: workspaceId } },
          body: { audit_retention_days: value },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async ({ audit_retention_days }, sent) => {
      onOutcome({
        kind: "notice",
        text: t("workspace.retentionSaved", { days: audit_retention_days }),
      });
      // Keep anything typed while the save was in flight.
      setDraft((typed) =>
        typed !== null && Number(typed) !== sent ? typed : null,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text:
          error.code === "BAD_REQUEST"
            ? t("workspace.retentionFloor")
            : refusalText(t, error, "audit_retention.manage", role),
      }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(Number(days));
  };

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("workspace.retention")}</h2>
      {/* noValidate: the server owns the floor and says why it refused. */}
      <form className="web-form" onSubmit={submit} noValidate>
        <label className="web-field">
          <span>{t("workspace.retentionDays")}</span>
          <input
            className="ap-input"
            type="number"
            inputMode="numeric"
            step={1}
            value={days}
            disabled={reason !== undefined}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <p id={hintId} className="web-field__hint">
          {t("workspace.retentionHint")}
        </p>
        <ReasonButton
          type="submit"
          className="ap-button ap-button--primary"
          reason={reason}
          disabled={save.isPending || days.trim() === ""}
        >
          {t("workspace.save")}
        </ReasonButton>
      </form>
    </section>
  );
}

/**
 * Whether Slack guests may call agents. Owners and admins flip it; the switch
 * sends the opposite of what the server last said, so a stale screen cannot
 * undo a change it never saw.
 */
function SlackGuest({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const enabled = me?.workspace?.settings.slack_guest_enabled ?? false;
  const titleId = useId();
  const labelId = useId();
  const hintId = useId();
  const reason = useHasPermission("workspace.manage")
    ? undefined
    : permissionReason(t, "workspace.manage", role);

  const save = useMutation<SlackGuestRequest, ApiError, boolean>({
    mutationFn: (value) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/slack-guest", {
          params: { path: { id: workspaceId } },
          body: { slack_guest_enabled: value },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async ({ slack_guest_enabled }) => {
      onOutcome({
        kind: "notice",
        text: t(
          slack_guest_enabled
            ? "workspace.guestSavedOn"
            : "workspace.guestSavedOff",
        ),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      }),
  });

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("workspace.guest")}</h2>
      <div className="web-check">
        <span id={labelId}>{t("workspace.guestLabel")}</span>
        <ReasonButton
          role="switch"
          aria-checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          reason={reason}
          disabled={save.isPending || me?.workspace === undefined}
          onClick={() => save.mutate(!enabled)}
        >
          {t(enabled ? "workspace.guestOn" : "workspace.guestOff")}
        </ReasonButton>
      </div>
      <p id={hintId} className="web-field__hint">
        {t("workspace.guestHint")}
      </p>
    </section>
  );
}
