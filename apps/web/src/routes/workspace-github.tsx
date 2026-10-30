import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  GetGitHubAppResponse,
  PutGitHubAppRequest,
  PutGitHubAppResponse,
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
  Link,
  RowListItem,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
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
import { GitHubAccess, githubSettingsKey } from "./workspace-github-access.tsx";
import {
  type OnOutcome,
  SettingsCard,
  WorkspacePage,
} from "./workspace-settings.tsx";
import { DangerZone, storeOff } from "./workspace-slack.tsx";

// Row buttons share one width down the right edge.
const ACTION = "min-w-12";
// GitHub's own limit is far below this; the server refuses past it anyway.
const KEY_FILE_MAX_BYTES = 16_384;

const appKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-app");

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

/** Workspace › GitHub: the App agents reach GitHub repositories with. */
export function WorkspaceGitHubScreen() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  return (
    <WorkspacePage page="github">
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <Notice>{outcome.text}</Notice>
        )
      ) : null}
      <GitHubApp onOutcome={setOutcome} />
    </WorkspacePage>
  );
}

function GitHubApp({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [missing, setMissing] = useState<"appId" | "key" | null>(null);
  const appIdId = useId();
  const appIdHint = useId();
  const keyId = useId();
  const keyHint = useId();
  const appIdRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const submitting = useRef(false);
  // The form replaces the button that opened it; focus follows each swap so
  // a keyboard user keeps their place.
  useEffect(() => {
    if (editing) appIdRef.current?.focus();
    else if (wasEditing.current && document.activeElement === document.body)
      actionRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const app = useQuery({
    queryKey: appKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-app", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "" && canManage,
    retry: (failures, error) => !storeOff(error) && failures < 3,
  });
  // The settings carry the App's permissions too.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: appKey(client, workspaceId) }),
      queryClient.invalidateQueries({
        queryKey: githubSettingsKey(client, workspaceId),
      }),
    ]);
  const refused = (error: ApiError) => {
    const reason = reasonOf(error);
    onOutcome({
      kind: "error",
      text:
        reason === "invalid_private_key"
          ? t("github.invalidKey")
          : reason === "github_app_rejected"
            ? t("github.rejected")
            : reason === "github_unreachable"
              ? t("github.saveUnreachable")
              : storeOff(error)
                ? t("workspace.tokenStoreUnavailable")
                : refusalText(t, error, "workspace.manage", role),
    });
  };

  const save = useMutation<PutGitHubAppResponse, ApiError, PutGitHubAppRequest>(
    {
      // The variables hold the private key; keep it nowhere once the attempt ends.
      gcTime: 0,
      mutationFn: (body) =>
        unwrap(
          client.PUT("/v1/workspaces/{id}/github-app", {
            params: { path: { id: workspaceId } },
            body,
          }),
        ),
      onMutate: () => onOutcome(null),
      onSuccess: () => {
        setEditing(false);
        onOutcome({ kind: "notice", text: t("github.saved") });
        // Not awaited: the reset that drops the key waits for this callback.
        void refresh();
      },
      onError: refused,
    },
  );
  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/workspaces/{id}/github-app", {
          params: { path: { id: workspaceId } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setDeleting(false);
      onOutcome({ kind: "notice", text: t("github.deleted") });
      await refresh();
    },
    onError: async (error) => {
      setDeleting(false);
      // Another tab or person deleted it first: it is gone either way.
      if (isApiError(error, "NOT_FOUND")) {
        const again = await app.refetch();
        if (again.data?.github_app === null) {
          onOutcome({ kind: "notice", text: t("github.deleted") });
          return;
        }
      }
      refused(error);
    },
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget.elements;
    const idInput = form.namedItem("app_id");
    const keyInput = form.namedItem("private_key");
    const appId = Number(
      idInput instanceof HTMLInputElement ? idInput.value.trim() : "",
    );
    const file =
      keyInput instanceof HTMLInputElement ? keyInput.files?.[0] : undefined;
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      setMissing("appId");
      if (idInput instanceof HTMLInputElement) idInput.focus();
      return;
    }
    if (file === undefined || file.size === 0) {
      setMissing("key");
      if (keyInput instanceof HTMLInputElement) keyInput.focus();
      return;
    }
    setMissing(null);
    if (file.size > KEY_FILE_MAX_BYTES) {
      onOutcome({ kind: "error", text: t("github.invalidKey") });
      return;
    }
    // Reading the file yields, so isPending alone lets a second submit in.
    if (save.isPending || submitting.current) return;
    submitting.current = true;
    const privateKey = await file.text();
    // Detach the observer so gcTime 0 drops the attempt and its key.
    save.mutate(
      { app_id: appId, private_key: privateKey },
      {
        onSettled: () => {
          submitting.current = false;
          save.reset();
        },
      },
    );
  };

  const data = app.data;
  const registered = data?.github_app ?? null;
  const installUrl = registered
    ? `${registered.html_url}/installations/new`
    : null;

  const appRows = !canManage ? (
    <SettingRow
      title={t("github.app")}
      description={permissionReason(t, "workspace.manage", role)}
    />
  ) : app.isPending ? (
    <RowListItem>
      <Skeleton width="50%" />
    </RowListItem>
  ) : app.isError ? (
    <RowListItem>
      {storeOff(app.error) ? (
        <ErrorState
          title={t("status.loadFailed")}
          message={t("workspace.tokenStoreUnavailable")}
        />
      ) : (
        <LoadFailure error={app.error} onRetry={() => void app.refetch()} />
      )}
    </RowListItem>
  ) : (
    <>
      <SettingRow
        title={registered?.name ?? t("github.app")}
        badge={<AppBadge data={data} />}
        description={appLine(data, t, locale)}
        actions={
          editing ? undefined : (
            <>
              {installUrl ? (
                <Link
                  href={installUrl}
                  target="_blank"
                  newTabLabel={t("github.newTab")}
                >
                  {t("github.install")}
                </Link>
              ) : null}
              <Button
                ref={actionRef}
                type="button"
                size="sm"
                variant={registered ? "outline" : "default"}
                className={ACTION}
                onClick={() => setEditing(true)}
              >
                {t(registered ? "github.replace" : "github.register")}
              </Button>
            </>
          )
        }
      />
      {editing ? (
        <RowListItem>
          <form
            className="flex w-full flex-col gap-4"
            noValidate
            onSubmit={(event) =>
              void submit(event).catch(() => {
                submitting.current = false;
                onOutcome({ kind: "error", text: t("github.invalidKey") });
              })
            }
          >
            <Field>
              <FieldLabel htmlFor={appIdId}>{t("github.appId")}</FieldLabel>
              <Input
                ref={appIdRef}
                id={appIdId}
                className="max-w-80"
                name="app_id"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                defaultValue={registered ? String(registered.app_id) : ""}
                aria-describedby={appIdHint}
                aria-invalid={missing === "appId" || undefined}
              />
              <FieldDescription id={appIdHint}>
                {t("github.appIdHint")}
              </FieldDescription>
              {missing === "appId" ? (
                <FieldError>{t("github.appIdMissing")}</FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={keyId}>{t("github.key")}</FieldLabel>
              <Input
                id={keyId}
                className="max-w-105"
                name="private_key"
                type="file"
                accept=".pem,application/x-pem-file"
                aria-describedby={keyHint}
                aria-invalid={missing === "key" || undefined}
                onChange={() => {
                  if (missing === "key") setMissing(null);
                }}
              />
              <FieldDescription id={keyHint}>
                {t("github.keyHint")}
              </FieldDescription>
              {missing === "key" ? (
                <FieldError>{t("github.keyMissing")}</FieldError>
              ) : null}
            </Field>
            <div className="flex flex-wrap items-start justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setMissing(null);
                  setEditing(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" aria-disabled={save.isPending || undefined}>
                {t("github.save")}
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
        title={t("github.app")}
        description={t("github.appHint")}
        rows={appRows}
      />
      <GitHubAccess
        fresh={
          canManage && app.isSuccess
            ? registered && { permissions: registered.permissions ?? null }
            : undefined
        }
        onOutcome={onOutcome}
      />
      {canManage && registered ? (
        <>
          <SettingsCard
            title={t("github.installations")}
            description={t("github.installationsHint")}
            rows={
              data?.installations.length ? (
                data.installations.map((installation) => (
                  <SettingRow
                    key={installation.id}
                    title={installation.account}
                    description={t(
                      installation.repository_selection === "all"
                        ? "github.selectionAll"
                        : "github.selectionSelected",
                    )}
                    actions={
                      installation.html_url ? (
                        <Link
                          href={installation.html_url}
                          target="_blank"
                          newTabLabel={t("github.newTab")}
                        >
                          {t("github.openOnGitHub")}
                        </Link>
                      ) : undefined
                    }
                  />
                ))
              ) : (
                <SettingRow
                  title={t("github.installationsEmpty")}
                  description={
                    data?.check?.state === "failed"
                      ? t(
                          data.check.reason_code === "github_rejected"
                            ? "github.rejectedNow"
                            : "github.unreachable",
                        )
                      : undefined
                  }
                />
              )
            }
          />
          <SettingsCard
            title={t("github.repositories")}
            description={t("github.repositoriesHint")}
            rows={
              data?.repositories.length ? (
                data.repositories.map((repository) => (
                  <SettingRow
                    key={repository.id}
                    title={repository.id}
                    description={repository.url}
                    badge={
                      data.check?.state !== "ok" ? (
                        <Badge>{t("github.unknown")}</Badge>
                      ) : repository.installation_id === null ? (
                        <Badge variant="amber">
                          {t("github.notInstalled")}
                        </Badge>
                      ) : (
                        <Badge variant="green">{t("github.installed")}</Badge>
                      )
                    }
                  />
                ))
              ) : (
                <SettingRow title={t("github.repositoriesEmpty")} />
              )
            }
          />
          <DangerZone>
            <SettingRow
              title={t("github.delete")}
              description={t("github.deleteHint")}
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
        </>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("github.deleteTitle")}
        consequence={t("github.deleteHint")}
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

function AppBadge({
  data,
}: {
  readonly data: GetGitHubAppResponse | undefined;
}) {
  const { t } = useI18n();
  if (!data?.github_app) return <Badge>{t("github.unset")}</Badge>;
  if (data.check?.state === "failed") {
    return <Badge variant="red">{t("github.checkFailed")}</Badge>;
  }
  return <Badge variant="green">{t("github.connected")}</Badge>;
}

function appLine(
  data: GetGitHubAppResponse | undefined,
  t: ReturnType<typeof useI18n>["t"],
  locale: ReturnType<typeof useI18n>["locale"],
): string {
  const app = data?.github_app;
  if (!app) return t("github.unsetLine");
  if (data.check?.state === "failed") {
    return t(
      data.check.reason_code === "github_rejected"
        ? "github.rejectedNow"
        : "github.unreachable",
    );
  }
  const at = formatTimestamp(app.private_key.updated_at, locale);
  const id = String(app.app_id);
  return app.private_key.updated_by
    ? t("github.appLine", {
        id,
        at,
        by: app.private_key.updated_by.display_name,
      })
    : t("github.appLineAt", { id, at });
}
