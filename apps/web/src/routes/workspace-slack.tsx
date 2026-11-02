import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  PutSlackConfigTokenResponse,
  SlackConfigTokenSummary,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  DangerZone,
  DangerZoneRow,
  ErrorState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FormActions,
  formatTimestamp,
  Input,
  Link,
  RowAction,
  RowListItem,
  SettingRow,
  SettingsSection,
  Skeleton,
  Steps,
} from "@werft-ai/ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  type OnOutcome,
  SlackGuest,
  WorkspacePage,
} from "./workspace-settings.tsx";
import { SlackApps, useWorkspaceSlackApps } from "./workspace-slack-apps.tsx";

const SLACK_APPS_URL = "https://api.slack.com/apps";

const tokenKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "slack-config-token");

function useConfigToken() {
  const { client } = useAgentPlatform();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  return useQuery({
    queryKey: tokenKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "" && canManage,
    retry: (failures, error) => !storeOff(error) && failures < 3,
  });
}

/**
 * Workspace › Slack: the app-making token first, then who may use agents
 * from Slack and the apps the token made. Until a token works and no app
 * exists, nothing below it can take effect, so only the token is shown.
 */
export function WorkspaceSlackScreen() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const canManage = useHasPermission("workspace.manage");
  const token = useConfigToken();
  const apps = useWorkspaceSlackApps();
  // A token that does not work yet hides what depends on it until the app
  // list says whether any app already runs. A failed read, even a refetch
  // over old data, is not an empty workspace; members can read neither.
  const unready = token.status === "success" && token.data.state !== "active";
  const deciding = unready && apps.status === "pending";
  const tokenOnly =
    unready && apps.status === "success" && apps.data.items.length === 0;
  const guest = <SlackGuest onOutcome={setOutcome} />;
  return (
    <WorkspacePage page="slack">
      <OutcomeLine outcome={outcome} />
      {/* Members can only read the guest setting; it leads for them. */}
      {canManage ? null : guest}
      <ConfigToken
        start={tokenOnly && token.data?.state === "unset"}
        deciding={deciding}
        onOutcome={setOutcome}
        after={
          tokenOnly || deciding ? null : (
            <>
              {canManage ? guest : null}
              <SlackApps />
            </>
          )
        }
      />
    </WorkspacePage>
  );
}

/**
 * The token only reads as a state and who saved it when; the value never
 * comes back. Replacing it is the same PUT as setting it the first time.
 */
function ConfigToken({
  start,
  deciding,
  onOutcome,
  after,
}: {
  /** No token and no app yet: one card that starts the connection. */
  readonly start: boolean;
  /** Whether `start` applies is not known yet. */
  readonly deciding: boolean;
  readonly onOutcome: OnOutcome;
  /** Sections under the token card; its danger zone stays last on the page. */
  readonly after?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // Saving or deleting can swap the button that held the focus for another.
  const focusOnState = useRef<"save" | "delete" | null>(null);
  const token = useConfigToken();
  const summary = token.data;
  // The form replaces the button that opened it; focus returns to that
  // button when the form closes, unless the user already moved on.
  useEffect(() => {
    if (
      !editing &&
      wasEditing.current &&
      document.activeElement === document.body
    )
      actionRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => {
    const after = focusOnState.current;
    if (summary?.state && after) {
      focusOnState.current = null;
      // Only when the focus went with what was swapped out (or sits in the
      // closing delete dialog), not when the user moved elsewhere.
      const at = document.activeElement;
      if (
        !at ||
        at === document.body ||
        !at.isConnected ||
        (after === "delete" &&
          at.closest('[role="dialog"], [role="alertdialog"]'))
      )
        actionRef.current?.focus();
    }
  }, [summary?.state]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: tokenKey(client, workspaceId) });
  const refusal = (error: ApiError) =>
    isApiError(error, "CONFIG_TOKEN_INVALID")
      ? t("workspace.tokenRejected")
      : storeOff(error)
        ? t("workspace.tokenStoreUnavailable")
        : refusalText(t, error, "workspace.manage", role);

  const save = useMutation<PutSlackConfigTokenResponse, ApiError, string>({
    // The variables hold the token; keep it nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: (value) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
          body: { value },
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setFormError(null);
    },
    onSuccess: async (stored) => {
      if (summary?.state !== "active") focusOnState.current = "save";
      // The answer is the new summary; show it before the re-read lands.
      const { receipt_id: _receipt, warnings: _warnings, ...next } = stored;
      queryClient.setQueryData<SlackConfigTokenSummary>(
        tokenKey(client, workspaceId),
        next,
      );
      setEditing(false);
      // The PUT itself is Slack's check: say who Slack says issued it.
      const verified = stored.issuer
        ? t("workspace.tokenVerified", {
            team: stored.issuer.team_id,
            user: stored.issuer.user_id,
          })
        : t("workspace.tokenStored");
      onOutcome({
        kind: "notice",
        text:
          stored.warnings.length > 0
            ? `${verified} ${t("workspace.tokenIssuerChanged")}`
            : verified,
      });
      // Not awaited: the reset that drops the value waits for this callback.
      void refresh();
    },
    onError: (error) => {
      setFormError(refusal(error));
      // A lost answer may still have spent the pasted token; read the state.
      void refresh();
    },
  });
  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setDeleting(false);
      focusOnState.current = "delete";
      onOutcome({ kind: "notice", text: t("workspace.tokenDeleted") });
      await refresh();
    },
    onError: async (error) => {
      setDeleting(false);
      // Another tab or person deleted it first: the token is gone either way.
      if (isApiError(error, "NOT_FOUND")) {
        const again = await token.refetch();
        if (again.data?.state === "unset") {
          focusOnState.current = "delete";
          onOutcome({ kind: "notice", text: t("workspace.tokenDeleted") });
          return;
        }
      }
      onOutcome({ kind: "error", text: refusal(error) });
    },
  });

  const close = () => {
    setFormError(null);
    setEditing(false);
  };
  const form = editing ? (
    <TokenForm
      pending={save.isPending}
      error={formError}
      onCancel={close}
      onSubmit={(value) => {
        if (!save.isPending) {
          // Detach the observer so gcTime 0 drops the attempt and its value.
          save.mutate(value, { onSettled: () => save.reset() });
        }
      }}
    />
  ) : null;

  if (start) {
    return (
      <SettingsSection
        title={t("workspace.slackStart")}
        description={t("workspace.slackStartHint")}
        rows={form ? <RowListItem>{form}</RowListItem> : undefined}
        foot={
          form ? undefined : (
            <Button
              ref={actionRef}
              type="button"
              onClick={() => setEditing(true)}
            >
              {t("workspace.tokenAdd")}
            </Button>
          )
        }
      />
    );
  }

  const rows = !canManage ? (
    <SettingRow
      title={t("workspace.token")}
      description={permissionReason(t, "workspace.manage", role)}
    />
  ) : token.isPending || deciding ? (
    <RowListItem>
      <Skeleton width="50%" />
    </RowListItem>
  ) : token.isError ? (
    <RowListItem>
      {storeOff(token.error) ? (
        <ErrorState
          title={t("status.loadFailed")}
          message={t("workspace.tokenStoreUnavailable")}
        />
      ) : (
        <LoadFailure error={token.error} onRetry={() => void token.refetch()} />
      )}
    </RowListItem>
  ) : (
    <>
      <SettingRow
        title={t("workspace.token")}
        badge={<TokenBadge summary={summary} />}
        description={tokenLine(summary, t, locale)}
        actions={
          editing ? undefined : (
            <RowAction
              ref={actionRef}
              variant={summary?.state === "active" ? "outline" : "default"}
              onClick={() => setEditing(true)}
            >
              {t(
                summary?.state === "active"
                  ? "workspace.tokenReplace"
                  : summary?.state === "needs_reentry"
                    ? "workspace.tokenReenter"
                    : "workspace.tokenAdd",
              )}
            </RowAction>
          )
        }
      />
      {form ? <RowListItem>{form}</RowListItem> : null}
    </>
  );

  return (
    <>
      <SettingsSection
        title={t("workspace.tokenSection")}
        description={t("workspace.tokenHint")}
        rows={rows}
      />
      {after}
      {canManage && summary?.configured && after ? (
        <DangerZone title={t("workspace.danger")}>
          <DangerZoneRow
            title={t("workspace.tokenDelete")}
            description={t("workspace.tokenDeleteHint")}
            actionLabel={t("workspace.delete")}
            actionName={t("workspace.tokenDelete")}
            onAction={() => setDeleting(true)}
          />
        </DangerZone>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("workspace.tokenDeleteTitle")}
        consequence={t("workspace.tokenDeleteHint")}
        target={summary?.last4 ? `••••${summary.last4}` : undefined}
        confirmLabel={t("workspace.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (!remove.isPending) remove.mutate();
        }}
      />
    </>
  );
}

/** Where to find the value in Slack, then the field that takes it. */
function TokenForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (value: string) => void;
}) {
  const { t } = useI18n();
  const [missing, setMissing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Mounted by the button that opened it; the field is where the user goes.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A second paste while the first is out stays in the field.
    if (pending) return;
    const input = event.currentTarget.elements.namedItem("token");
    const value = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!value) {
      setMissing(true);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setMissing(false);
    // Slack spends the pasted token on the first try, so it is no use in
    // the field afterwards; keep the secret out of the DOM either way.
    if (input instanceof HTMLInputElement) input.value = "";
    onSubmit(value);
  };
  const shownError = missing ? t("workspace.tokenMissing") : error;

  return (
    <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
      <Steps
        items={[
          {
            id: "open",
            title: (
              <Link
                href={SLACK_APPS_URL}
                target="_blank"
                newTabLabel={t("slack.newTab")}
              >
                {t("workspace.tokenStepOpen")}
              </Link>
            ),
          },
          { id: "generate", title: t("workspace.tokenStepGenerate") },
          { id: "paste", title: t("workspace.tokenStepPaste") },
        ]}
      />
      <Field>
        <FieldLabel>{t("workspace.tokenNew")}</FieldLabel>
        <Input
          ref={inputRef}
          className="max-w-105"
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            if (event.target.value.trim()) setMissing(false);
          }}
        />
        <FieldDescription>{t("workspace.tokenNewHint")}</FieldDescription>
        <FieldError>{shownError}</FieldError>
      </Field>
      <FormActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" aria-disabled={pending || undefined}>
          {t("workspace.tokenSubmit")}
        </Button>
      </FormActions>
    </form>
  );
}

function TokenBadge({
  summary,
}: {
  readonly summary: SlackConfigTokenSummary | undefined;
}) {
  const { t } = useI18n();
  if (summary?.state === "active") {
    return <Badge variant="green">{t("workspace.tokenActive")}</Badge>;
  }
  if (summary?.state === "needs_reentry") {
    return <Badge variant="red">{t("workspace.tokenNeedsReentry")}</Badge>;
  }
  return <Badge>{t("workspace.tokenUnset")}</Badge>;
}

function tokenLine(
  summary: SlackConfigTokenSummary | undefined,
  t: ReturnType<typeof useI18n>["t"],
  locale: ReturnType<typeof useI18n>["locale"],
): string | undefined {
  if (summary?.state === "needs_reentry") {
    return t("workspace.tokenNeedsReentryHint");
  }
  if (summary?.state === "unset") return t("workspace.tokenUnsetHint");
  if (!summary?.updated_at) return undefined;
  const at = formatTimestamp(summary.updated_at, locale);
  // updated_at moves on every successful exchange with Slack, registering or
  // the automatic refresh; updated_by stays the last person who registered.
  return [
    summary.last4 ? `••••${summary.last4}` : null,
    summary.issuer
      ? t("workspace.tokenTeam", { id: summary.issuer.team_id })
      : null,
    summary.issuer
      ? t("workspace.tokenIssuer", { id: summary.issuer.user_id })
      : null,
    t("workspace.tokenCheckedAt", { at }),
    summary.updated_by
      ? t("workspace.tokenRegisteredBy", {
          by: summary.updated_by.display_name,
        })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

// The API answers this way when it runs without its secret key; a retry
// cannot help, an administrator has to configure the store.
export const storeOff = (error: unknown) =>
  isApiError(error, "BACKEND_UNAVAILABLE") && error.retryable === false;
