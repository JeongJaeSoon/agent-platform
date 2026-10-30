import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  GetGitHubAppResponse,
  GitHubAppPermissions,
  GitHubAppRole,
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

const appKey = (client: ApiClient, workspaceId: string, role: GitHubAppRole) =>
  scopedKey(client, "workspace", workspaceId, "github-apps", role);

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
      <GitHubApp appRole="author" onOutcome={setOutcome}>
        <GitHubApp appRole="reviewer" onOutcome={setOutcome} />
      </GitHubApp>
    </WorkspacePage>
  );
}

/**
 * One role's App. The author's page holds the rest of the screen, with
 * `children` (the reviewer's card) right under its own card.
 */
function GitHubApp({
  appRole,
  onOutcome,
  children,
}: {
  readonly appRole: GitHubAppRole;
  readonly onOutcome: OnOutcome;
  readonly children?: ReactNode;
}) {
  const author = appRole === "author";
  const { t, locale } = useI18n();
  const deletedText = t(author ? "github.deleted" : "github.reviewer.deleted");
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
    queryKey: appKey(client, workspaceId, appRole),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-apps/{role}", {
          params: { path: { id: workspaceId, role: appRole } },
        }),
      ),
    enabled: workspaceId !== "" && canManage,
    retry: (failures, error) => !storeOff(error) && failures < 3,
  });
  // The settings carry the App's permissions too.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: appKey(client, workspaceId, appRole),
      }),
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
          : reason === "same_app"
            ? t(author ? "github.sameAsReviewer" : "github.reviewer.sameApp")
            : reason === "no_author_app"
              ? t("github.reviewer.noAuthorApp")
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
          client.PUT("/v1/workspaces/{id}/github-apps/{role}", {
            params: { path: { id: workspaceId, role: appRole } },
            body,
          }),
        ),
      onMutate: () => onOutcome(null),
      onSuccess: () => {
        setEditing(false);
        onOutcome({
          kind: "notice",
          text: t(author ? "github.saved" : "github.reviewer.saved"),
        });
        // Not awaited: the reset that drops the key waits for this callback.
        void refresh();
      },
      onError: refused,
    },
  );
  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/workspaces/{id}/github-apps/{role}", {
          params: { path: { id: workspaceId, role: appRole } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setDeleting(false);
      onOutcome({ kind: "notice", text: deletedText });
      await refresh();
    },
    onError: async (error) => {
      setDeleting(false);
      // Another tab or person deleted it first: it is gone either way.
      if (isApiError(error, "NOT_FOUND")) {
        const again = await app.refetch();
        if (again.data?.github_app === null) {
          onOutcome({ kind: "notice", text: deletedText });
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
        title={
          registered?.name ?? t(author ? "github.app" : "github.reviewer.app")
        }
        badge={<AppBadge data={data} />}
        description={appLine(data, t, locale, appRole)}
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

  const confirm = (
    <ConfirmDialog
      open={deleting}
      onOpenChange={setDeleting}
      title={t(author ? "github.deleteTitle" : "github.reviewer.deleteTitle")}
      consequence={t(
        author ? "github.deleteHint" : "github.reviewer.deleteHint",
      )}
      confirmLabel={t("workspace.delete")}
      cancelLabel={t("common.cancel")}
      tone="danger"
      busy={remove.isPending}
      onConfirm={() => {
        if (!remove.isPending) remove.mutate();
      }}
    />
  );

  if (!author) {
    return (
      <>
        <SettingsCard
          title={t("github.reviewer.title")}
          description={t("github.reviewer.hint")}
          rows={
            <>
              {appRows}
              {canManage && registered
                ? data?.repositories.map((repository) => (
                    <SettingRow
                      key={repository.id}
                      title={repository.id}
                      description={repository.url}
                      badge={
                        <InstallBadge data={data} repository={repository} />
                      }
                    />
                  ))
                : null}
              {registered ? null : (
                <SettingRow
                  title={t("github.reviewer.permissionsTitle")}
                  description={t("github.reviewer.permissions")}
                />
              )}
              <SettingRow
                title={t("github.reviewer.riskTitle")}
                description={t("github.reviewer.risk")}
              />
              {canManage && registered ? (
                <SettingRow
                  title={t("github.reviewer.delete")}
                  description={t("github.reviewer.deleteHint")}
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
              ) : null}
            </>
          }
        />
        {confirm}
      </>
    );
  }

  return (
    <>
      <SettingsCard
        title={t("github.app")}
        description={t("github.appHint")}
        rows={appRows}
      />
      {children}
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
                    badge={<InstallBadge data={data} repository={repository} />}
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
      {confirm}
    </>
  );
}

function InstallBadge({
  data,
  repository,
}: {
  readonly data: GetGitHubAppResponse;
  readonly repository: GetGitHubAppResponse["repositories"][number];
}) {
  const { t } = useI18n();
  if (data.check?.state !== "ok") return <Badge>{t("github.unknown")}</Badge>;
  if (repository.installation_id === null) {
    return <Badge variant="amber">{t("github.notInstalled")}</Badge>;
  }
  if (
    approvalPending(
      data.github_app?.permissions,
      repository.installation_permissions,
    )
  ) {
    return <Badge variant="amber">{t("github.approvalPending")}</Badge>;
  }
  return <Badge variant="green">{t("github.installed")}</Badge>;
}

const RANK = { read: 1, write: 2, admin: 3 } as const;

/** The App asks for more than the installation has accepted so far. */
function approvalPending(
  app: GitHubAppPermissions | null | undefined,
  installation: GitHubAppPermissions | null | undefined,
): boolean {
  if (!app || !installation) return false;
  return Object.entries(app).some(([name, level]) => {
    const held = installation[name];
    return held === undefined || RANK[level] > RANK[held];
  });
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
  role: GitHubAppRole,
): string {
  const app = data?.github_app;
  if (!app) {
    return t(
      role === "author" ? "github.unsetLine" : "github.reviewer.unsetLine",
    );
  }
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
