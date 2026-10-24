import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AuditRetentionRequest,
  SlackGuestRequest,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  buttonVariants,
  Card,
  CardDescription,
  CardFooter,
  CardTitle,
  Input,
  Page,
  RowList,
  SecretField,
  SettingRow,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { profilesQuery, queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { FormError, Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import type { Outcome } from "../components/outcome.tsx";
import { useI18n } from "../i18n/i18n.tsx";

// The server's ceiling; the web takes contracts as types only, so a test
// keeps this equal to the contract's value.
export const AUDIT_RETENTION_MAX_DAYS = 3650;

// Console v4 settings (Console.dc.html L853-867): `card flush` cards 16px
// apart, a 16px body with 12px gaps, and a `form-foot` strip under it.
const CARDS = "flex flex-col gap-4";
const CARD_BODY = "flex flex-col gap-3 p-4";
const SUB = "text-description";
const META = "text-caption text-subtle-foreground";
const ICON = "size-3.5 shrink-0";
// Wide enough for the longer of On/Off, so the label does not reflow on a flip.
const STATUS = `${META} min-w-6 text-right`;
// The card draws the box; the rows only keep the rule under the body.
const ROWS = "rounded-none border-x-0 border-b-0 bg-transparent";

type OnOutcome = (outcome: Outcome | null) => void;

/** Workspace-wide settings an owner or admin opens from the menu. */
export function WorkspaceSettingsScreen() {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const workspaceManage = useHasPermission("workspace.manage");
  const retentionManage = useHasPermission("audit_retention.manage");
  const editable = workspaceManage || retentionManage;
  return (
    <Page
      title={t("workspace.title")}
      description={t(editable ? "workspace.description" : "workspace.readOnly")}
    >
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <Notice>{outcome.text}</Notice>
        )
      ) : null}
      <div className={CARDS}>
        <WorkspaceName />
        <WorkspaceId />
        <AllowedModels />
        {editable ? (
          <>
            <AuditRetention onOutcome={setOutcome} />
            <SlackGuest onOutcome={setOutcome} />
          </>
        ) : (
          <ReadOnlySettings />
        )}
      </div>
    </Page>
  );
}

function SettingsCard({
  title,
  description,
  descriptionId,
  rows,
  foot,
  onSubmit,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly descriptionId?: string;
  /** SettingRows under the body, edge to edge like the foot. */
  readonly rows?: ReactNode;
  readonly foot?: ReactNode;
  readonly onSubmit?: (event: FormEvent) => void;
  readonly children?: ReactNode;
}) {
  const titleId = useId();
  const content = (
    <>
      <div className={CARD_BODY}>
        <CardTitle id={titleId} role="heading" aria-level={2}>
          {title}
        </CardTitle>
        <CardDescription id={descriptionId} className={SUB}>
          {description}
        </CardDescription>
        {children}
      </div>
      {rows ? (
        <RowList variant="joined" className={ROWS}>
          {rows}
        </RowList>
      ) : null}
      {foot ? <CardFooter variant="form">{foot}</CardFooter> : null}
    </>
  );
  return (
    <Card flush role="region" aria-labelledby={titleId}>
      {onSubmit ? (
        // noValidate: the server owns the limits and says why it refused.
        <form onSubmit={onSubmit} noValidate>
          {content}
        </form>
      ) : (
        content
      )}
    </Card>
  );
}

function ReadOnlyMark() {
  const { t } = useI18n();
  return (
    <div className="inline-flex shrink-0 items-center gap-1 text-caption text-subtle-foreground">
      <Lock aria-hidden="true" className={ICON} strokeWidth={1.5} />
      {t("workspace.readOnlyMark")}
    </div>
  );
}

/** No API renames a workspace yet (94S-817), so the name only reads. */
function WorkspaceName() {
  const { t } = useI18n();
  const name = useMe()?.workspace?.name ?? "";
  const inputId = useId();
  return (
    <SettingsCard
      title={t("workspace.name")}
      description={t("workspace.nameHint")}
      foot={
        <>
          <div className={META}>{t("workspace.nameFoot")}</div>
          <ReadOnlyMark />
        </>
      }
    >
      <label className="sr-only" htmlFor={inputId}>
        {t("workspace.name")}
      </label>
      <Input id={inputId} className="max-w-80" value={name} readOnly />
    </SettingsCard>
  );
}

function WorkspaceId() {
  const { t } = useI18n();
  const id = useMe()?.workspace?.id ?? "";
  return (
    <SettingsCard title={t("workspace.id")} description={t("workspace.idHint")}>
      <SecretField
        className="max-w-105"
        value={id}
        copyLabel={t("apiKeys.copy")}
        copiedMessage={t("workspace.idCopied")}
        copyFailedMessage={t("apiKeys.copyIdFailed")}
      />
    </SettingsCard>
  );
}

/**
 * The models this installation's profiles run: the ceiling a session picks
 * under. The operator's catalog sets it, so the console only reads it.
 */
function AllowedModels() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const profiles = useQuery(profilesQuery(client));
  const models = [...new Set(profiles.data?.items.map((p) => p.model))];
  return (
    <SettingsCard
      title={t("workspace.models")}
      description={t("workspace.modelsHint")}
      foot={
        <>
          <div className={META}>{t("workspace.modelsFoot")}</div>
          <ReadOnlyMark />
        </>
      }
    >
      {profiles.isPending ? (
        <Skeleton width="50%" />
      ) : profiles.isError ? (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      ) : models.length === 0 ? (
        <div className={META}>{t("workspace.modelsEmpty")}</div>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {models.map((model) => (
            <li key={model}>
              <Badge variant="mono">{model}</Badge>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

/** The settings as they stand, for someone who may change none of them. */
function ReadOnlySettings() {
  const { t } = useI18n();
  const settings = useMe()?.workspace?.settings;
  return (
    <>
      <SettingsCard
        title={t("workspace.retention")}
        description={t("workspace.retentionHint")}
      >
        <div>
          {settings
            ? t("workspace.retentionValue", {
                days: settings.audit_retention_days,
              })
            : "—"}
        </div>
      </SettingsCard>
      <SettingsCard
        title={t("workspace.guest")}
        description={t("workspace.guestHint")}
      >
        <div>
          {t(
            settings?.slack_guest_enabled
              ? "workspace.guestValueOn"
              : "workspace.guestValueOff",
          )}
        </div>
      </SettingsCard>
    </>
  );
}

/**
 * How long refused and allowed decisions are kept. Only an owner changes it;
 * the floor is the server's, so a short value goes there and comes back as
 * the refusal. The mockup's output retention (7/30/90 days) has no API yet
 * (94S-817); this card is the audit retention, a different value.
 */
function AuditRetention({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const current = me?.workspace?.settings.audit_retention_days;
  // Untouched, the field follows the server's value as it refreshes.
  const [draft, setDraft] = useState<string | null>(null);
  const days = draft ?? (current === undefined ? "" : `${current}`);
  const inputId = useId();
  const hintId = useId();
  const footId = useId();
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
    onError: (error, sent) =>
      onOutcome({
        kind: "error",
        text:
          error.code !== "BAD_REQUEST"
            ? refusalText(t, error, "audit_retention.manage", role)
            : sent > AUDIT_RETENTION_MAX_DAYS
              ? t("workspace.retentionCeiling", {
                  max: AUDIT_RETENTION_MAX_DAYS,
                })
              : t("workspace.retentionFloor"),
      }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    save.mutate(Number(days));
  };

  return (
    <SettingsCard
      title={t("workspace.retention")}
      description={t("workspace.retentionHint")}
      descriptionId={hintId}
      onSubmit={submit}
      foot={
        <>
          <div id={footId} className={META}>
            {t("workspace.retentionFoot")}
          </div>
          <ReasonButton
            type="submit"
            className={buttonVariants({
              size: "sm",
              className: "aria-disabled:opacity-45",
            })}
            reason={reason}
            // aria-disabled, not disabled: a disabled button drops its focus.
            aria-disabled={save.isPending || undefined}
            disabled={days.trim() === ""}
          >
            {t("workspace.save")}
          </ReasonButton>
        </>
      }
    >
      <label className="sr-only" htmlFor={inputId}>
        {t("workspace.retentionDays")}
      </label>
      <Input
        id={inputId}
        className="max-w-50"
        type="number"
        inputMode="numeric"
        step={1}
        value={days}
        aria-describedby={`${hintId} ${footId}`}
        disabled={reason !== undefined}
        onChange={(event) => setDraft(event.target.value)}
      />
    </SettingsCard>
  );
}

/**
 * Whether Slack guests may call agents. Owners and admins flip it; the switch
 * sends the opposite of what the server last said, so a stale screen cannot
 * undo a change it never saw.
 */
function SlackGuest({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const me = useMe();
  const role = useRole();
  const workspaceId = me?.workspace?.id ?? "";
  const enabled = me?.workspace?.settings.slack_guest_enabled ?? false;
  const hintId = useId();
  const reasonId = useId();
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
    <SettingsCard
      title={t("workspace.guest")}
      description={t("workspace.guestHint")}
      descriptionId={hintId}
      rows={
        <SettingRow
          title={t("workspace.guestLabel")}
          meta={
            reason === undefined ? null : (
              <div id={reasonId} className="text-caption text-muted-foreground">
                {reason}
              </div>
            )
          }
          status={
            // aria-checked already says it; the words are for sighted users.
            <div aria-hidden="true" className={STATUS}>
              {t(enabled ? "workspace.guestOn" : "workspace.guestOff")}
            </div>
          }
          control={
            <Switch
              checked={enabled}
              aria-describedby={reason === undefined ? hintId : reasonId}
              aria-disabled={save.isPending || undefined}
              disabled={reason !== undefined || me?.workspace === undefined}
              onCheckedChange={(next) => save.mutate(next)}
            />
          }
        />
      }
    />
  );
}
