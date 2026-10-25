import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type { SlackConfigTokenSummary } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
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
import { type FormEvent, type ReactNode, useId, useState } from "react";
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

// Row buttons share one width down the right edge.
const ACTION = "min-w-12";

const tokenKey = (workspaceId: string) =>
  ["workspace", workspaceId, "slack-config-token"] as const;

/** Workspace › Slack: who may use agents from Slack, and the app-making token. */
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
      <ConfigToken onOutcome={setOutcome} />
    </WorkspacePage>
  );
}

/**
 * The token only reads as a state and who saved it when; the value never
 * comes back. Replacing it is the same PUT as setting it the first time.
 */
function ConfigToken({ onOutcome }: { readonly onOutcome: OnOutcome }) {
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

  const token = useQuery({
    queryKey: tokenKey(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "" && canManage,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: tokenKey(workspaceId) });
  const refused = (error: ApiError) =>
    onOutcome({
      kind: "error",
      text: isApiError(error, "CONFIG_TOKEN_INVALID")
        ? t("workspace.tokenRejected")
        : refusalText(t, error, "workspace.manage", role),
    });

  const save = useMutation<unknown, ApiError, string>({
    mutationFn: (value) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/slack/config-token", {
          params: { path: { id: workspaceId } },
          body: { value },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setEditing(false);
      onOutcome({ kind: "notice", text: t("workspace.tokenStored") });
      await refresh();
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
    onError: (error) => {
      setDeleting(false);
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
    if (!save.isPending) save.mutate(value);
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
      <LoadFailure error={token.error} onRetry={() => void token.refetch()} />
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
                id={inputId}
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
  return summary.updated_by
    ? t("workspace.tokenSavedBy", { at, by: summary.updated_by.display_name })
    : t("workspace.tokenSavedAt", { at });
}

/** The last block of a settings page: what cannot be undone. */
function DangerZone({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <h2
        id={titleId}
        className="m-0 border-b pb-2 font-semibold text-body leading-6"
      >
        {t("workspace.danger")}
      </h2>
      <RowList
        variant="joined"
        style={{ borderColor: "var(--ap-tone-danger-border)" }}
      >
        {children}
      </RowList>
    </section>
  );
}
