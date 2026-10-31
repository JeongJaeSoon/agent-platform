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
  ErrorState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Input,
  RowList,
  RowListItem,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
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
import { FormError, Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import type { Outcome } from "../components/outcome.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  type OnOutcome,
  SettingsCard,
  SlackGuest,
  WorkspacePage,
} from "./workspace-settings.tsx";
import { SlackApps } from "./workspace-slack-apps.tsx";

// Row buttons share one width down the right edge.
const ACTION = "min-w-12";

const tokenKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "slack-config-token");

/** Workspace › Slack: who may use agents from Slack, the app-making token, and the apps it made. */
export function WorkspaceSlackScreen() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  return (
    <WorkspacePage page="slack">
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <Notice>{outcome.text}</Notice>
        )
      ) : null}
      <SlackGuest onOutcome={setOutcome} />
      <ConfigToken onOutcome={setOutcome} after={<SlackApps />} />
    </WorkspacePage>
  );
}

/**
 * The token only reads as a state and who saved it when; the value never
 * comes back. Replacing it is the same PUT as setting it the first time.
 */
function ConfigToken({
  onOutcome,
  after,
}: {
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
  const [missing, setMissing] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // The form replaces the button that opened it; focus follows each swap so
  // a keyboard user keeps their place.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
    // Only when the closing form took focus with it, not when the user moved.
    else if (wasEditing.current && document.activeElement === document.body)
      actionRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const token = useQuery({
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
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: tokenKey(client, workspaceId) });
  const refused = (error: ApiError) =>
    onOutcome({
      kind: "error",
      text: isApiError(error, "CONFIG_TOKEN_INVALID")
        ? t("workspace.tokenRejected")
        : storeOff(error)
          ? t("workspace.tokenStoreUnavailable")
          : refusalText(t, error, "workspace.manage", role),
    });

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
    onMutate: () => onOutcome(null),
    onSuccess: async (stored) => {
      setEditing(false);
      onOutcome({
        kind: "notice",
        text: t(
          stored.warnings.length > 0
            ? "workspace.tokenIssuerChanged"
            : "workspace.tokenStored",
        ),
      });
      // Not awaited: the reset that drops the value waits for this callback.
      void refresh();
    },
    onError: refused,
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
      onOutcome({ kind: "notice", text: t("workspace.tokenDeleted") });
      await refresh();
    },
    onError: async (error) => {
      setDeleting(false);
      // Another tab or person deleted it first: the token is gone either way.
      if (isApiError(error, "NOT_FOUND")) {
        const again = await token.refetch();
        if (again.data?.state === "unset") {
          onOutcome({ kind: "notice", text: t("workspace.tokenDeleted") });
          return;
        }
      }
      refused(error);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("token");
    const value = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!value) {
      setMissing(true);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setMissing(false);
    if (!save.isPending) {
      // Detach the observer so gcTime 0 drops the attempt and its value.
      save.mutate(value, { onSettled: () => save.reset() });
    }
  };

  const summary = token.data;
  const rows = !canManage ? (
    <SettingRow
      title={t("workspace.token")}
      description={permissionReason(t, "workspace.manage", role)}
    />
  ) : token.isPending ? (
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
            <Button
              ref={actionRef}
              type="button"
              size="sm"
              variant={
                summary?.state === "needs_reentry" ? "default" : "outline"
              }
              className={ACTION}
              onClick={() => setEditing(true)}
            >
              {t(
                summary?.state === "unset"
                  ? "workspace.tokenAdd"
                  : "workspace.tokenReplace",
              )}
            </Button>
          )
        }
      />
      {editing ? (
        <RowListItem>
          <form
            className="flex w-full flex-col gap-4"
            noValidate
            onSubmit={submit}
          >
            <Field>
              <FieldLabel htmlFor={inputId}>
                {t("workspace.tokenNew")}
              </FieldLabel>
              <Input
                ref={inputRef}
                id={inputId}
                className="max-w-105"
                name="token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={hintId}
                onChange={(event) => {
                  if (event.target.value.trim()) setMissing(false);
                }}
              />
              <FieldDescription id={hintId}>
                {t("workspace.tokenNewHint")}
              </FieldDescription>
              {missing ? (
                <FieldError>{t("workspace.tokenMissing")}</FieldError>
              ) : null}
            </Field>
            <div className="flex flex-wrap items-start justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setMissing(false);
                  setEditing(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" aria-disabled={save.isPending || undefined}>
                {t("workspace.save")}
              </Button>
            </div>
          </form>
        </RowListItem>
      ) : null}
    </>
  );

  return (
    <>
      <SettingsCard
        title={t("workspace.token")}
        description={t("workspace.tokenHint")}
        rows={rows}
      />
      {after}
      {canManage && summary?.configured ? (
        <DangerZone>
          <SettingRow
            title={t("workspace.tokenDelete")}
            description={t("workspace.tokenDeleteHint")}
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={`${ACTION} text-(color:--ap-tone-danger-fg)`}
                onClick={() => setDeleting(true)}
              >
                {t("workspace.delete")}
              </Button>
            }
          />
        </DangerZone>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("workspace.tokenDeleteTitle")}
        consequence={t("workspace.tokenDeleteHint")}
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
  if (!summary?.updated_at) return undefined;
  const at = formatTimestamp(summary.updated_at, locale);
  return [
    summary.last4 ? `••••${summary.last4}` : null,
    summary.updated_by
      ? t("workspace.tokenSavedBy", { at, by: summary.updated_by.display_name })
      : t("workspace.tokenSavedAt", { at }),
    summary.issuer
      ? t("workspace.tokenIssuer", { id: summary.issuer.user_id })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

// The API answers this way when it runs without its secret key; a retry
// cannot help, an administrator has to configure the store.
export const storeOff = (error: unknown) =>
  isApiError(error, "BACKEND_UNAVAILABLE") && error.retryable === false;

export function DangerZone({
  titleAs: Heading = "h2",
  children,
}: {
  readonly titleAs?: "h2" | "h3";
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <Heading
        id={titleId}
        className="m-0 border-b pb-2 font-semibold text-body leading-6"
      >
        {t("workspace.danger")}
      </Heading>
      <RowList
        variant="joined"
        style={{ borderColor: "var(--ap-tone-danger-border)" }}
      >
        {children}
      </RowList>
    </section>
  );
}
