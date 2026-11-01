import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  GetGitHubAppResponse,
  GitHubAppRole,
  PutGitHubAppRequest,
  PutGitHubAppResponse,
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
  formatTimestamp,
  Input,
  Link,
  RowList,
  RowListItem,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import { Building2 } from "lucide-react";
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
import { IconTile } from "../components/icon-tile.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import type { Outcome } from "../components/outcome.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { approvalPending } from "./github-permission-table.ts";
import {
  AppPermissionTable,
  AppTile,
  Ceiling,
  GITHUB_APP_ANCHOR,
  GITHUB_REVIEWER_ANCHOR,
  githubSettingsKey,
  useGitHubSettings,
} from "./workspace-github-access.tsx";
import { NewAppForm } from "./workspace-github-new-app.tsx";
import { RepositoryCatalog } from "./workspace-github-repositories.tsx";
import {
  GITHUB_USER_LINK_ANCHOR,
  GitHubUserLinkSection,
  userLinkReady,
} from "./workspace-github-user-link.tsx";
import {
  type OnOutcome,
  SettingsCard,
  WorkspacePage,
} from "./workspace-settings.tsx";
import { storeOff } from "./workspace-slack.tsx";

// Row buttons share one width down the right edge.
const ACTION = "min-w-12";
// GitHub's own limit is far below this; the server refuses past it anyway.
const KEY_FILE_MAX_BYTES = 16_384;

const appKey = (client: ApiClient, workspaceId: string, role: GitHubAppRole) =>
  scopedKey(client, "workspace", workspaceId, "github-apps", role);

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

const REPOSITORIES_ANCHOR = "github-repositories";
const META = "text-caption text-subtle-foreground";
const PRIVATE_KEYS_DOC =
  "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps";

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
      <GitHubApp
        appRole="author"
        onOutcome={setOutcome}
        danger={
          <GitHubApp appRole="reviewer" part="danger" onOutcome={setOutcome} />
        }
      >
        <ReviewerAdvanced onOutcome={setOutcome} />
      </GitHubApp>
    </WorkspacePage>
  );
}

/**
 * The reviewer App, behind "Advanced": most workspaces run on the author App
 * alone, and reviews stay with people until one is registered.
 */
function ReviewerAdvanced({ onOutcome }: { readonly onOutcome: OnOutcome }) {
  const { t } = useI18n();
  const canManage = useHasPermission("workspace.manage");
  const reviewer = useGitHubAppQuery("reviewer");
  const registered = Boolean(reviewer.data?.github_app);
  const [chosen, setChosen] = useState<boolean | null>(null);
  // Open while one is registered, and stay open once it is deleted here.
  useEffect(() => {
    if (registered) setChosen((was) => was ?? true);
  }, [registered]);
  const open = chosen ?? registered;
  const panelId = useId();
  if (!canManage) return null;
  return (
    <section
      id={GITHUB_REVIEWER_ANCHOR}
      aria-label={t("github.reviewer.title")}
    >
      <RowList variant="joined">
        <SettingRow
          title={
            <span className="flex items-center gap-2">
              <AppTile app="reviewer" />
              {t("github.reviewer.title")}
            </span>
          }
          badge={
            <Badge>
              {registered
                ? t("github.reviewer.advanced")
                : t("github.reviewer.advancedUnset")}
            </Badge>
          }
          description={t("github.reviewer.hint")}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              onClick={() => setChosen(!open)}
            >
              {t(open ? "github.reviewer.close" : "github.reviewer.open")}
            </Button>
          }
        />
        {open ? (
          <li id={panelId} className="list-none">
            <RowList variant="joined" className="rounded-none border-0">
              <GitHubApp appRole="reviewer" onOutcome={onOutcome} />
            </RowList>
          </li>
        ) : null}
      </RowList>
    </section>
  );
}

/** One line over the page: what is connected, and what still needs a look. */
function GitHubSummary({
  app,
  userLink,
}: {
  readonly app: GetGitHubAppResponse;
  readonly userLink: boolean | undefined;
}) {
  const { t } = useI18n();
  const needsCheck = app.repositories.filter(
    (repository) => repositoryState(app, repository) !== "installed",
  ).length;
  const cell = (href: string, label: string, value: ReactNode) => (
    <Link
      href={`#${href}`}
      className="flex min-w-0 flex-col gap-1 rounded-card border bg-card px-3 py-2 font-normal text-foreground no-underline hover:bg-hover hover:no-underline"
    >
      <span className={META}>{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-control">
        {value}
      </span>
    </Link>
  );
  return (
    <nav
      aria-label={t("github.summary.label")}
      className="grid grid-cols-2 gap-2 lg:grid-cols-4"
    >
      {cell(
        GITHUB_APP_ANCHOR,
        t("github.app"),
        app.github_app ? (
          <>
            <AppTile app="author" />
            <span className="truncate">{app.github_app.name}</span>
          </>
        ) : (
          <Badge>{t("github.unset")}</Badge>
        ),
      )}
      {cell(
        GITHUB_APP_ANCHOR,
        t("github.summary.accounts"),
        t("github.summary.accountsValue", { count: app.installations.length }),
      )}
      {cell(
        REPOSITORIES_ANCHOR,
        t("github.repositories"),
        <>
          {t("github.summary.repositoriesValue", {
            count: app.repositories.length,
          })}
          {needsCheck > 0 ? (
            <Badge variant="amber">
              {t("github.summary.needsCheck", { count: needsCheck })}
            </Badge>
          ) : null}
        </>,
      )}
      {cell(
        GITHUB_USER_LINK_ANCHOR,
        t("github.summary.userLink"),
        userLink === undefined ? null : userLink ? (
          <Badge variant="green">{t("github.summary.ready")}</Badge>
        ) : (
          <Badge variant="amber">{t("github.summary.setupNeeded")}</Badge>
        ),
      )}
    </nav>
  );
}

type RepositoryState = "unknown" | "notInstalled" | "pending" | "installed";

function repositoryState(
  data: GetGitHubAppResponse,
  repository: GetGitHubAppResponse["repositories"][number],
): RepositoryState {
  if (data.check?.state !== "ok") return "unknown";
  if (repository.installation_id === null) return "notInstalled";
  if (
    approvalPending(
      data.github_app?.permissions,
      repository.installation_permissions,
    )
  ) {
    return "pending";
  }
  return "installed";
}

/** The accounts the App is installed on, each with how its repositories stand. */
function Installations({ data }: { readonly data: GetGitHubAppResponse }) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 font-semibold text-control">
        {t("github.installations")}
      </h3>
      {data.installations.length === 0 ? (
        <>
          <p className={`m-0 ${META}`}>{t("github.installationsEmpty")}</p>
          {data.check?.state === "failed" ? (
            <p className={`m-0 ${META}`}>
              {t(
                data.check.reason_code === "github_rejected"
                  ? "github.rejectedNow"
                  : "github.unreachable",
              )}
            </p>
          ) : null}
        </>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {data.installations.map((installation) => {
            const repositories = data.repositories.filter(
              (repository) => repository.installation_id === installation.id,
            );
            const pending = repositories.some(
              (repository) => repositoryState(data, repository) === "pending",
            );
            return (
              <li
                key={installation.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border px-3 py-2"
              >
                <IconTile icon={Building2} hue="slate" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-control">
                    {installation.account}
                  </span>
                  <span className={META}>
                    {t("github.installationLine", {
                      selection: t(
                        installation.repository_selection === "all"
                          ? "github.selectionAll"
                          : "github.selectionSelected",
                      ),
                      count: repositories.length,
                    })}
                  </span>
                </span>
                {repositories.length > 0 ? (
                  pending ? (
                    <Badge variant="amber">{t("github.approvalPending")}</Badge>
                  ) : (
                    <Badge variant="green">
                      {t("github.installationApproved")}
                    </Badge>
                  )
                ) : null}
                {installation.html_url ? (
                  <Link
                    href={installation.html_url}
                    target="_blank"
                    newTabLabel={t("github.newTab")}
                  >
                    {t("github.openOnGitHub")}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Link href={`#${REPOSITORIES_ANCHOR}`} className="text-caption">
        {t("github.repositoriesByAccount")}
      </Link>
    </div>
  );
}

function useGitHubAppQuery(appRole: GitHubAppRole) {
  const { client } = useAgentPlatform();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  return useQuery({
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
}

/**
 * One role's App. The author's page holds the rest of the screen, with
 * `children` (the reviewer's card) right under its own card.
 */
function GitHubApp({
  appRole,
  onOutcome,
  part = "page",
  danger,
  children,
}: {
  readonly appRole: GitHubAppRole;
  readonly onOutcome: OnOutcome;
  /** "danger": only this App's danger zone rows, for the author's zone. */
  readonly part?: "page" | "danger";
  /** Another App's danger zone rows, after this one's. */
  readonly danger?: ReactNode;
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
  // "choose": a confirmed replace, before picking how the new App comes in.
  const [mode, setMode] = useState<"new" | "existing" | "choose" | null>(null);
  const editing = mode === "existing";
  const setEditing = (on: boolean) => setMode(on ? "existing" : null);
  const [deleting, setDeleting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [missing, setMissing] = useState<"appId" | "key" | null>(null);
  const appIdId = useId();
  const appIdHint = useId();
  const introId = useId();
  const keyId = useId();
  const keyHint = useId();
  const appIdRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const submitting = useRef(false);
  // The form replaces the button that opened it; focus follows each swap so
  // a keyboard user keeps their place.
  const chooseRef = useRef<HTMLButtonElement>(null);
  const open = mode !== null;
  useEffect(() => {
    if (editing) appIdRef.current?.focus();
    else if (mode === "choose") chooseRef.current?.focus();
    else if (
      !open &&
      wasEditing.current &&
      document.activeElement === document.body
    )
      actionRef.current?.focus();
    wasEditing.current = open;
  }, [editing, open, mode]);

  const app = useGitHubAppQuery(appRole);
  // Either App can be deleted alone, so the zone stays while the reviewer's
  // rows have an App to act on.
  const reviewerApp = useGitHubAppQuery("reviewer");
  const settings = useGitHubSettings(author);
  // The settings carry the App's permissions and the user-linking client id
  // (whose secret goes with the App), so they are read again with it.
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
    <>
      <SettingRow
        title={t("github.app")}
        description={permissionReason(t, "workspace.manage", role)}
      />
      {/* Members read the App's permissions from the settings' last read. */}
      {author && settings.data?.apps.author ? (
        <RowListItem>
          <AppPermissionTable
            permissions={settings.data.apps.author.permissions}
            ceiling={settings.data.ceiling}
          />
        </RowListItem>
      ) : null}
    </>
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
          <span className="flex min-w-0 items-center gap-2">
            <AppTile app={appRole} />
            {registered?.name ??
              t(author ? "github.app" : "github.reviewer.app")}
          </span>
        }
        badge={<AppBadge data={data} />}
        description={appLine(data, t, locale, appRole)}
        actions={
          mode !== null && !registered ? undefined : (
            <>
              {installUrl ? (
                <Link
                  href={installUrl}
                  target="_blank"
                  newTabLabel={t("github.newTab")}
                >
                  {t(
                    data?.installations.length
                      ? "github.manageRepositories"
                      : "github.install",
                  )}
                </Link>
              ) : null}
              {/* Replacing a registered App is in the danger zone. */}
              {registered ? null : author ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={ACTION}
                    onClick={() => setEditing(true)}
                  >
                    {t("github.addExisting")}
                  </Button>
                  <Button
                    ref={actionRef}
                    type="button"
                    size="sm"
                    className={ACTION}
                    onClick={() => setMode("new")}
                  >
                    {t("github.newApp")}
                  </Button>
                </>
              ) : (
                <Button
                  ref={actionRef}
                  type="button"
                  size="sm"
                  className={ACTION}
                  onClick={() => setEditing(true)}
                >
                  {t("github.register")}
                </Button>
              )}
            </>
          )
        }
      />
      {editing && !registered ? appForm() : null}
      {mode === "new" && !registered ? newAppForm() : null}
      {author && registered && data ? (
        <RowListItem className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <AppPermissionTable
            permissions={registered.permissions ?? null}
            ceiling={settings.data?.ceiling}
          />
          <Installations data={data} />
        </RowListItem>
      ) : null}
    </>
  );

  function newAppForm() {
    return (
      <NewAppForm
        workspaceId={workspaceId}
        replace={registered !== null}
        blocked={Boolean(data?.manifest_blocked)}
        onCancel={() => setMode(null)}
        onOutcome={onOutcome}
      />
    );
  }

  // Under the card's row for a first App, under the danger zone's row when it
  // replaces one. Hoisted: appRows above renders it.
  function appForm() {
    // A first author App: the reviewer and the replace forms skip the intro.
    const adding = author && !registered;
    return (
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
          {adding ? (
            <div
              id={introId}
              className="text-description text-muted-foreground"
            >
              {t("github.addExistingHint")}{" "}
              <Link
                href={PRIVATE_KEYS_DOC}
                target="_blank"
                newTabLabel={t("github.newTab")}
              >
                {t("github.privateKeysLink")}
              </Link>
            </div>
          ) : null}
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
              // Focus lands here, so the intro is read with the field.
              aria-describedby={adding ? `${introId} ${appIdHint}` : appIdHint}
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            {adding ? (
              <div className={`${META} mr-auto`}>{t("github.connectNote")}</div>
            ) : null}
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
              {t(registered ? "github.save" : "github.connect")}
            </Button>
          </div>
        </form>
      </RowListItem>
    );
  }

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
      target={registered?.name}
      tone="danger"
      busy={remove.isPending}
      onConfirm={() => {
        if (!remove.isPending) remove.mutate();
      }}
    />
  );

  const replaceRow = t(
    author ? "github.replaceRow" : "github.reviewer.replaceRow",
  );
  const replaceHint = t(
    author ? "github.replaceHint" : "github.reviewer.replaceHint",
  );
  // The author's danger zone holds the reviewer's rows too, so both Apps'
  // replace and delete sit last on the page.
  const dangerRows =
    canManage && registered ? (
      <>
        {mode === "choose" ? (
          <SettingRow
            title={replaceRow}
            description={t("github.replaceChoose")}
            actions={
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setMode(null)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                >
                  {t("github.addExisting")}
                </Button>
                <Button
                  ref={chooseRef}
                  type="button"
                  size="sm"
                  onClick={() => setMode("new")}
                >
                  {t("github.newApp")}
                </Button>
              </>
            }
          />
        ) : mode === "new" ? (
          <>
            <SettingRow
              title={replaceRow}
              description={t("github.replaceRowHint")}
            />
            {newAppForm()}
          </>
        ) : editing ? (
          <>
            <SettingRow
              title={replaceRow}
              description={t("github.replaceRowHint")}
            />
            {appForm()}
          </>
        ) : (
          <DangerZoneRow
            title={replaceRow}
            description={t("github.replaceRowHint")}
            actionLabel={t("github.replace")}
            actionName={replaceRow}
            actionRef={actionRef}
            onAction={() => setReplacing(true)}
          />
        )}
        <DangerZoneRow
          title={t(author ? "github.delete" : "github.reviewer.delete")}
          description={t(
            author ? "github.deleteHint" : "github.reviewer.deleteHint",
          )}
          actionLabel={t("workspace.delete")}
          actionName={t(author ? "github.delete" : "github.reviewer.delete")}
          onAction={() => setDeleting(true)}
        />
        <ConfirmDialog
          open={replacing}
          onOpenChange={setReplacing}
          title={t(
            author ? "github.replaceTitle" : "github.reviewer.replaceTitle",
          )}
          consequence={`${replaceHint} ${t("github.replaceNext")}`}
          target={registered.name}
          confirmLabel={t("github.replace")}
          cancelLabel={t("common.cancel")}
          tone="danger"
          onConfirm={() => {
            setReplacing(false);
            // Only the author App can come from a manifest.
            setMode(author ? "choose" : "existing");
          }}
        />
        {confirm}
      </>
    ) : null;

  if (part === "danger") return dangerRows;

  if (!author) {
    // Rows inside ReviewerAdvanced's list, under its "Advanced" row.
    return (
      <>
        {appRows}
        {canManage && registered
          ? data?.repositories.map((repository) => (
              <SettingRow
                key={repository.id}
                title={repository.id}
                description={repository.url}
                badge={<InstallBadge data={data} repository={repository} />}
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
      </>
    );
  }

  // GET …/github-apps reads GitHub now; the settings carry the last read.
  // Owners and admins see the fresh one, and none once the App is deleted.
  const fresh = canManage && app.isSuccess;
  const reviewerRegistered = reviewerApp.data?.github_app ?? null;
  const authorSide = fresh
    ? registered && {
        name: registered.name,
        permissions: registered.permissions ?? null,
      }
    : settings.data?.apps.author
      ? { name: null, permissions: settings.data.apps.author.permissions }
      : null;
  const reviewerSide =
    canManage && reviewerApp.isSuccess
      ? reviewerRegistered && {
          name: reviewerRegistered.name,
          permissions: reviewerRegistered.permissions ?? null,
        }
      : settings.data?.apps.reviewer
        ? { name: null, permissions: settings.data.apps.reviewer.permissions }
        : null;

  return (
    <>
      {canManage && data ? (
        <GitHubSummary
          app={data}
          userLink={settings.data ? userLinkReady(settings.data) : undefined}
        />
      ) : null}
      <SettingsCard
        id={GITHUB_APP_ANCHOR}
        title={t("github.app")}
        description={t("github.appHint")}
        rows={appRows}
      />
      {children}
      {canManage && registered ? (
        <RepositoryCatalog
          id={REPOSITORIES_ANCHOR}
          installBadge={(repositoryId) => {
            const repository = data?.repositories.find(
              (held) => held.id === repositoryId,
            );
            return data && repository ? (
              <InstallBadge data={data} repository={repository} />
            ) : null;
          }}
          onChanged={() =>
            queryClient.invalidateQueries({
              queryKey: appKey(client, workspaceId, appRole),
            })
          }
          onOutcome={onOutcome}
        />
      ) : null}
      <Ceiling
        settings={settings}
        author={authorSide || null}
        reviewer={reviewerSide || null}
        onOutcome={onOutcome}
      />
      {canManage && registered ? (
        <GitHubUserLinkSection
          workspaceId={workspaceId}
          appReadAt={app.dataUpdatedAt}
          onOutcome={onOutcome}
        />
      ) : null}
      {canManage && (registered || reviewerApp.data?.github_app) ? (
        <DangerZone title={t("workspace.danger")}>
          {dangerRows}
          {danger}
        </DangerZone>
      ) : null}
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
  switch (repositoryState(data, repository)) {
    case "unknown":
      return <Badge>{t("github.unknown")}</Badge>;
    case "notInstalled":
      return <Badge variant="amber">{t("github.notInstalled")}</Badge>;
    case "pending":
      return <Badge variant="amber">{t("github.approvalPending")}</Badge>;
    case "installed":
      return <Badge variant="green">{t("github.installed")}</Badge>;
  }
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
