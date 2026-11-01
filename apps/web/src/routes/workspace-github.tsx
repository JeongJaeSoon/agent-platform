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
  GitHubCeiling,
  ListGitHubRepositoriesResponse,
  PutGitHubAppRequest,
  PutGitHubAppResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardDescription,
  CardTitle,
  ConfirmDialog,
  DangerZone,
  DangerZoneRow,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Input,
  Link,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
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
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import { lackingOf, permissionTable } from "./github-permission-table.ts";
import {
  AppTile,
  type CeilingDraft,
  FeatureList,
  githubSettingsKey,
  levelText,
  META,
  PermissionTable,
  permissionName,
  useCeilingDraft,
  useGitHubSettings,
} from "./workspace-github-access.tsx";
import {
  InstalledRepositories,
  OutsideRepositories,
  pageFailureOf,
  repositoriesKey,
  useRepositoryPage,
} from "./workspace-github-repositories.tsx";
import { GitHubUserLinkSection } from "./workspace-github-user-link.tsx";
import { type OnOutcome, WorkspacePage } from "./workspace-settings.tsx";
import { storeOff } from "./workspace-slack.tsx";

// GitHub's own limit is far below this; the server refuses past it anyway.
const KEY_FILE_MAX_BYTES = 16_384;
const ROLES = ["author", "reviewer"] as const;
const PRIVATE_KEYS_DOC =
  "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps";

const appKey = (client: ApiClient, workspaceId: string, role: GitHubAppRole) =>
  scopedKey(client, "workspace", workspaceId, "github-apps", role);

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

type RegisteredApp = NonNullable<GetGitHubAppResponse["github_app"]>;

/** An App as this viewer may see it: managers read GitHub, members the settings. */
type AppView = {
  readonly role: GitHubAppRole;
  readonly name: string;
  readonly appId: number;
  readonly permissions: GitHubAppPermissions | null;
  /** GET …/github-apps/{role}: owners and admins only. */
  readonly managed: GetGitHubAppResponse & { github_app: RegisteredApp };
} | {
  readonly role: GitHubAppRole;
  readonly name: string;
  readonly appId: number;
  readonly permissions: GitHubAppPermissions | null;
  readonly managed: null;
};

/** The App's settings page on GitHub, under the account that owns it. */
function appSettingsUrl(app: RegisteredApp): string | null {
  if (!app.owner) return null;
  const origin = new URL(app.html_url).origin;
  return app.owner.type === "Organization"
    ? `${origin}/organizations/${app.owner.login}/settings/apps/${app.slug}`
    : `${origin}/settings/apps/${app.slug}`;
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
 * Workspace › GitHub: a section a role, each with the features that role's
 * App lets agents turn on and the App's card (who it is, its permissions
 * against those features, and the repositories its installations reach).
 */
export function WorkspaceGitHubScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [adding, setAdding] = useState<GitHubAppRole | "pick" | null>(null);
  const [rotating, setRotating] = useState<GitHubAppRole | null>(null);
  const [focus, setFocus] = useState<GitHubAppRole | "danger" | null>(null);
  const settings = useGitHubSettings();
  const ceiling = useCeilingDraft(settings, setOutcome);
  const author = useGitHubAppQuery("author");
  const reviewer = useGitHubAppQuery("reviewer");
  const queries = { author, reviewer };

  const viewOf = (role: GitHubAppRole): AppView | null | undefined => {
    if (canManage) {
      const query = queries[role];
      if (query.isPending || query.isError) return undefined;
      const app = query.data.github_app;
      return app
        ? {
            role,
            name: app.name,
            appId: app.app_id,
            permissions: app.permissions ?? null,
            managed: { ...query.data, github_app: app },
          }
        : null;
    }
    if (settings.data === undefined) return undefined;
    const app = settings.data.apps[role];
    return app
      ? {
          role,
          name: app.name,
          appId: app.app_id,
          permissions: app.permissions,
          managed: null,
        }
      : null;
  };
  const views = { author: viewOf("author"), reviewer: viewOf("reviewer") };
  const empty = ROLES.filter((role) => views[role] === null);

  const refresh = (role: GitHubAppRole) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: appKey(client, workspaceId, role),
      }),
      // The settings carry the App's name and permissions, and the
      // user-linking client id whose secret goes with the author App.
      queryClient.invalidateQueries({
        queryKey: githubSettingsKey(client, workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: repositoriesKey(client, workspaceId),
      }),
    ]);

  const managerFailure = canManage
    ? ROLES.map((role) => queries[role]).find((query) => query.isError)
    : undefined;
  const anyApp = views.author || views.reviewer;
  const loading =
    views.author === undefined || views.reviewer === undefined;

  return (
    <WorkspacePage
      page="github"
      description={canManage ? undefined : t("github.descriptionMember")}
      actions={
        canManage ? (
          <Button type="button" size="sm" onClick={() => setAdding("pick")}>
            <Plus aria-hidden="true" className="size-4" />
            {t("github.add")}
          </Button>
        ) : undefined
      }
    >
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <Notice>{outcome.text}</Notice>
        )
      ) : null}
      {managerFailure?.error ? (
        storeOff(managerFailure.error) ? (
          <ErrorState
            title={t("status.loadFailed")}
            message={t("workspace.tokenStoreUnavailable")}
          />
        ) : (
          <LoadFailure
            error={managerFailure.error}
            onRetry={() => void managerFailure.refetch()}
          />
        )
      ) : loading ? (
        <Skeleton width="50%" />
      ) : !anyApp ? (
        <EmptyApps canManage={canManage} onAdd={() => setAdding("author")} />
      ) : (
        <>
          {ROLES.map((role) => (
            <RoleSection
              key={role}
              appRole={role}
              app={views[role] ?? null}
              settings={settings}
              ceiling={ceiling}
              canManage={canManage}
              focus={focus === role}
              onAdd={() => setAdding(role)}
              onRotate={() => setRotating(role)}
              onGone={() => void refresh(role)}
              onOutcome={setOutcome}
            />
          ))}
          {canManage && views.author ? (
            <GitHubUserLinkSection
              workspaceId={workspaceId}
              appName={views.author.name}
              appReadAt={author.dataUpdatedAt}
              onOutcome={setOutcome}
            />
          ) : null}
          {canManage ? (
            <Disconnect
              apps={ROLES.flatMap((role) => {
                const view = views[role];
                return view ? [view] : [];
              })}
              userLinked={Boolean(settings.data?.oauth.client_secret_set)}
              focus={focus === "danger"}
              onDone={(role) => {
                setFocus("danger");
                void refresh(role);
              }}
              onOutcome={setOutcome}
            />
          ) : null}
        </>
      )}
      {canManage ? (
        <>
          <AppDialog
            mode={adding === null ? null : "add"}
            initialRole={adding === "pick" ? empty[0] : (adding ?? undefined)}
            empty={empty}
            app={null}
            onClose={() => setAdding(null)}
            onSaved={(role) => {
              setAdding(null);
              setFocus(role);
              void refresh(role);
            }}
            onOutcome={setOutcome}
          />
          <AppDialog
            mode={rotating === null ? null : "rotate"}
            initialRole={rotating ?? undefined}
            empty={empty}
            app={
              rotating === null
                ? null
                : (queries[rotating].data?.github_app ?? null)
            }
            onClose={() => setRotating(null)}
            onSaved={(role) => {
              setRotating(null);
              void refresh(role);
            }}
            onOutcome={setOutcome}
          />
        </>
      ) : null}
    </WorkspacePage>
  );
}

function EmptyApps({
  canManage,
  onAdd,
}: {
  readonly canManage: boolean;
  readonly onAdd: () => void;
}) {
  const { t } = useI18n();
  const role = useRole();
  return (
    <Card className="flex flex-col items-start gap-3 p-6">
      <CardTitle role="heading" aria-level={2}>
        {t("github.empty.title")}
      </CardTitle>
      <CardDescription className="text-description">
        {canManage
          ? t("github.empty.hint")
          : permissionReason(t, "workspace.manage", role)}
      </CardDescription>
      {canManage ? (
        <Button type="button" size="sm" onClick={onAdd}>
          <Plus aria-hidden="true" className="size-4" />
          {t("github.add")}
        </Button>
      ) : null}
    </Card>
  );
}

function RoleSection({
  appRole,
  app,
  settings,
  ceiling,
  canManage,
  focus,
  onAdd,
  onRotate,
  onGone,
  onOutcome,
}: {
  readonly appRole: GitHubAppRole;
  readonly app: AppView | null;
  readonly settings: ReturnType<typeof useGitHubSettings>;
  readonly ceiling: CeilingDraft;
  readonly canManage: boolean;
  readonly focus: boolean;
  readonly onAdd: () => void;
  readonly onRotate: () => void;
  readonly onGone: () => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const [catalog, setCatalog] = useState<
    ListGitHubRepositoriesResponse["catalog"]
  >([]);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="m-0 font-semibold text-body leading-5">
          {t(`github.role.${appRole}.title`)}
        </h2>
        <p className={`m-0 max-w-[72ch] ${META}`}>
          {t(`github.role.${appRole}.hint`)}
        </p>
      </div>
      <FeatureList
        appRole={appRole}
        settings={settings}
        ceiling={ceiling}
        canManage={canManage}
        hasApp={app !== null}
      />
      {app ? (
        ceiling.shown && ceiling.saved ? (
          <AppCard
            app={app}
            shown={ceiling.shown}
            saved={ceiling.saved}
            focus={focus}
            onRotate={onRotate}
            onGone={onGone}
            onCatalog={setCatalog}
            onOutcome={onOutcome}
          />
        ) : null
      ) : canManage ? (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={onAdd}>
            <Plus aria-hidden="true" className="size-4" />
            {t(`github.role.${appRole}.add`)}
          </Button>
        </div>
      ) : (
        <p className={`m-0 ${META}`}>{t(`github.role.${appRole}.none`)}</p>
      )}
      {appRole === "author" && canManage && app ? (
        <OutsideRepositories catalog={catalog} onOutcome={onOutcome} />
      ) : null}
    </section>
  );
}

function keyBadge(t: Translate, check: GetGitHubAppResponse["check"]) {
  if (check === null) return null;
  if (check.state === "ok") {
    return <Badge variant="green">{t("github.connected")}</Badge>;
  }
  return check.reason_code === "github_rejected" ? (
    <Badge variant="red">{t("github.card.keyRejected")}</Badge>
  ) : (
    <Badge>{t("github.unknown")}</Badge>
  );
}

/**
 * One App: who it is, a warning when the switches need more than it holds,
 * its installations, its permission table against the picked one, and the
 * repositories that installation reaches.
 */
function AppCard({
  app,
  shown,
  saved,
  focus,
  onRotate,
  onGone,
  onCatalog,
  onOutcome,
}: {
  readonly app: AppView;
  readonly shown: GitHubCeiling;
  readonly saved: GitHubCeiling;
  readonly focus: boolean;
  readonly onRotate: () => void;
  readonly onGone: () => void;
  readonly onCatalog: (
    catalog: ListGitHubRepositoriesResponse["catalog"],
  ) => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const managed = app.managed;
  const installations = [...(managed?.installations ?? [])].sort(
    (a, b) => a.account.localeCompare(b.account) || a.id - b.id,
  );
  const [chosen, setChosen] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const installation =
    installations.find((one) => one.id === chosen) ?? installations[0];
  const list = useRepositoryPage(installation?.id, page);
  const failure = list.isError ? pageFailureOf(list.error) : null;
  const listed = list.data?.installations ?? [];
  const approved =
    listed.find((one) => one.id === installation?.id)?.permissions ?? null;

  useEffect(() => {
    if (focus) titleRef.current?.focus();
  }, [focus]);
  useEffect(() => {
    if (app.role === "author" && list.data) onCatalog(list.data.catalog);
  }, [app.role, list.data, onCatalog]);
  // An installation gone from GitHub: read the App's installations again
  // and go back to the first.
  useEffect(() => {
    if (failure === "gone") {
      setChosen(undefined);
      setPage(1);
      onGone();
    }
  }, [failure, onGone]);
  // Repositories went away under a later page: show the last one there is.
  const data = list.data;
  useEffect(() => {
    if (data && data.repositories.length === 0 && data.page > 1) {
      setPage(Math.max(1, Math.ceil(data.total_count / data.per_page)));
    }
  }, [data]);

  const lacking = app.permissions
    ? lackingOf(app.role, app.permissions, shown)
    : [];
  const lackingNow = app.permissions
    ? lackingOf(app.role, app.permissions, saved).length > 0
    : false;
  const registered = managed?.github_app;
  const settingsUrl = registered ? appSettingsUrl(registered) : null;
  const pending = app.permissions
    ? permissionTable({
        role: app.role,
        app: app.permissions,
        approved,
        ceiling: shown,
        saved,
      }).pending
    : false;
  const label = `${app.name} · ${installation?.account ?? ""}`;
  const count = (id: number) =>
    listed.find((one) => one.id === id)?.repository_count ?? undefined;

  return (
    <Card flush role="region" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <AppTile role={app.role} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle
                id={titleId}
                ref={titleRef}
                tabIndex={-1}
                role="heading"
                aria-level={3}
                className="min-w-0 truncate"
              >
                {app.name}
              </CardTitle>
              <Badge className="shrink-0">
                {t(`github.role.${app.role}.badge`)}
              </Badge>
              {managed ? keyBadge(t, managed.check) : null}
            </div>
            <span className={`truncate ${META}`}>
              {registered
                ? registered.private_key.updated_by
                  ? t("github.appLine", {
                      id: String(app.appId),
                      at: formatTimestamp(
                        registered.private_key.updated_at,
                        locale,
                      ),
                      by: registered.private_key.updated_by.display_name,
                    })
                  : t("github.appLineAt", {
                      id: String(app.appId),
                      at: formatTimestamp(
                        registered.private_key.updated_at,
                        locale,
                      ),
                    })
                : t("github.card.memberLine", { id: String(app.appId) })}
            </span>
          </div>
        </div>
        {managed ? (
          <div className="ml-13 flex shrink-0 items-center gap-3 sm:ml-0">
            {settingsUrl ? (
              <Link
                href={settingsUrl}
                target="_blank"
                newTabLabel={t("github.newTab")}
              >
                {t("github.card.settings")}
              </Link>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t("github.card.rotateName", { name: app.name })}
              onClick={onRotate}
            >
              {t("github.card.rotate")}
            </Button>
          </div>
        ) : null}
      </div>
      {managed?.check?.state === "failed" ? (
        <div className="px-4 pb-2">
          <Alert variant="amber">
            <AlertDescription>
              {t(
                managed.check.reason_code === "github_rejected"
                  ? "github.rejectedNow"
                  : "github.unreachable",
              )}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {lacking.length > 0 ? (
        <div className="px-4 pb-2">
          <Alert variant="amber">
            <AlertTitle>
              {t("github.card.lackingTitle", {
                list: lacking
                  .map(
                    ([name, level]) =>
                      `${permissionName(t, name)} ${levelText(t, level)}`,
                  )
                  .join(", "),
              })}
            </AlertTitle>
            <AlertDescription>
              {t(
                lackingNow
                  ? "github.card.lackingNow"
                  : "github.card.lackingDraft",
              )}{" "}
              {t("github.card.lackingFix")}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="flex flex-col gap-4 border-t p-4">
        {!managed ? null : installation ? (
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              {installations.length > 1 ? (
                <SegmentedControl
                  aria-label={t("github.card.accounts", { name: app.name })}
                  value={String(installation.id)}
                  onValueChange={(value) => {
                    setChosen(Number(value));
                    setPage(1);
                  }}
                >
                  {installations.map((one) => (
                    <SegmentedControlItem
                      key={one.id}
                      value={String(one.id)}
                      count={count(one.id)}
                    >
                      {one.account}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              ) : (
                <span className="font-medium text-control">
                  {installation.account}
                </span>
              )}
              {count(installation.id) === undefined ? null : (
                <span className={META}>
                  {t(
                    installation.repository_selection === "all"
                      ? "github.card.selectionAll"
                      : "github.card.selectionSelected",
                    { count: count(installation.id) ?? 0 },
                  )}
                </span>
              )}
              {pending ? (
                <Badge variant="amber">{t("github.approvalPending")}</Badge>
              ) : null}
            </div>
            {installation.html_url ? (
              <Link
                href={installation.html_url}
                target="_blank"
                newTabLabel={t("github.newTab")}
              >
                {t("github.card.manageInstallation")}
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span className={META}>{t("github.card.noInstallation")}</span>
            {registered ? (
              <Link
                href={`${registered.html_url}/installations/new`}
                target="_blank"
                newTabLabel={t("github.newTab")}
              >
                {t("github.install")}
              </Link>
            ) : null}
          </div>
        )}
        {/* Stacked, so repository names get the card's full width. */}
        <div className="flex flex-col gap-6">
          <PermissionTable
            appRole={app.role}
            appName={app.name}
            permissions={app.permissions}
            approved={approved}
            ceiling={shown}
            saved={saved}
            onRetry={managed ? onGone : undefined}
          />
          {managed && installation ? (
            <InstalledRepositories
              label={label}
              list={list}
              page={page}
              onPage={setPage}
              failure={failure}
              onRotate={onRotate}
              manageUrl={installation.html_url}
              onOutcome={onOutcome}
            />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * Adds an App to an empty role, or rotates a registered App's key: the
 * same PUT, which checks the key against GitHub before keeping it.
 */
function AppDialog({
  mode,
  initialRole,
  empty,
  app,
  onClose,
  onSaved,
  onOutcome,
}: {
  readonly mode: "add" | "rotate" | null;
  readonly initialRole: GitHubAppRole | undefined;
  readonly empty: readonly GitHubAppRole[];
  /** The App whose key is rotated. */
  readonly app: RegisteredApp | null;
  readonly onClose: () => void;
  readonly onSaved: (role: GitHubAppRole) => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const [appRole, setAppRole] = useState<GitHubAppRole | undefined>(
    initialRole,
  );
  const [missing, setMissing] = useState<"appId" | "key" | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const submitting = useRef(false);
  const ids = {
    appId: useId(),
    appIdHint: useId(),
    key: useId(),
    keyHint: useId(),
    role: useId(),
  };
  const open = mode !== null;
  useEffect(() => {
    if (open) {
      setAppRole(initialRole);
      setMissing(null);
      setRefusal(null);
    }
  }, [open, initialRole]);
  const rotate = mode === "rotate";

  const save = useMutation<
    PutGitHubAppResponse,
    ApiError,
    PutGitHubAppRequest & { readonly appRole: GitHubAppRole }
  >({
    // The variables hold the private key; keep it nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: ({ appRole: target, ...body }) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-apps/{role}", {
          params: { path: { id: workspaceId, role: target } },
          body,
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setRefusal(null);
    },
    onSuccess: (saved, { appRole: target }) => {
      onOutcome({
        kind: "notice",
        text: t(rotate ? "github.rotated" : "github.added", {
          name: saved.github_app.name,
        }),
      });
      onSaved(target);
    },
    onError: (error, { appRole: target }) => {
      const reason = reasonOf(error);
      setRefusal(
        reason === "invalid_private_key"
          ? t("github.invalidKey")
          : reason === "same_app"
            ? t(
                target === "author"
                  ? "github.sameAsReviewer"
                  : "github.reviewer.sameApp",
              )
            : reason === "no_author_app"
              ? t("github.reviewer.noAuthorApp")
              : reason === "github_app_rejected"
                ? t("github.rejected")
                : reason === "github_unreachable"
                  ? t("github.saveUnreachable")
                  : storeOff(error)
                    ? t("workspace.tokenStoreUnavailable")
                    : refusalText(t, error, "workspace.manage", role),
      );
    },
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget.elements;
    const idInput = form.namedItem("app_id");
    const keyInput = form.namedItem("private_key");
    const target = rotate ? initialRole : appRole;
    if (target === undefined) return;
    const appId = rotate
      ? (app?.app_id ?? 0)
      : Number(idInput instanceof HTMLInputElement ? idInput.value.trim() : "");
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
      setRefusal(t("github.invalidKey"));
      return;
    }
    // Reading the file yields, so isPending alone lets a second submit in.
    if (save.isPending || submitting.current) return;
    submitting.current = true;
    const pem = await file.text();
    // Detach the observer so gcTime 0 drops the attempt and its key.
    save.mutate(
      { appRole: target, app_id: appId, private_key: pem },
      {
        onSettled: () => {
          submitting.current = false;
          save.reset();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {rotate
              ? t("github.rotate.title", { name: app?.name ?? "" })
              : t("github.addDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t(rotate ? "github.rotate.hint" : "github.addDialog.hint")}{" "}
            <Link
              href={PRIVATE_KEYS_DOC}
              target="_blank"
              newTabLabel={t("github.newTab")}
            >
              {t("github.privateKeysLink")}
            </Link>
          </DialogDescription>
        </DialogHeader>
        {!rotate && empty.length === 0 ? (
          <>
            <p className="m-0 text-description">{t("github.addDialog.full")}</p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("github.addDialog.close")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) =>
              void submit(event).catch(() => {
                submitting.current = false;
                setRefusal(t("github.invalidKey"));
              })
            }
          >
            {refusal ? <FormError>{refusal}</FormError> : null}
            {rotate ? null : (
              <Field>
                <FieldLabel id={ids.role}>{t("github.addDialog.role")}</FieldLabel>
                <RadioGroup
                  value={appRole ?? ""}
                  onValueChange={(value) => setAppRole(value as GitHubAppRole)}
                  aria-labelledby={ids.role}
                >
                  {ROLES.map((one) => {
                    const taken = !empty.includes(one);
                    return (
                      <div key={one} className="flex items-start gap-2">
                        <RadioGroupItem
                          id={`${ids.role}-${one}`}
                          value={one}
                          disabled={taken}
                        />
                        <label
                          htmlFor={`${ids.role}-${one}`}
                          className="flex flex-col"
                        >
                          <span>{t(`github.role.${one}.badge`)}</span>
                          <span className={META}>
                            {taken
                              ? t("github.addDialog.taken")
                              : t(`github.addDialog.${one}Hint`)}
                          </span>
                        </label>
                      </div>
                    );
                  })}
                </RadioGroup>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={ids.appId}>{t("github.appId")}</FieldLabel>
              <Input
                id={ids.appId}
                className="max-w-80"
                name="app_id"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                readOnly={rotate}
                defaultValue={rotate && app ? String(app.app_id) : ""}
                aria-describedby={ids.appIdHint}
                aria-invalid={missing === "appId" || undefined}
              />
              <FieldDescription id={ids.appIdHint}>
                {t(rotate ? "github.rotate.appIdHint" : "github.appIdHint")}
              </FieldDescription>
              {missing === "appId" ? (
                <FieldError>{t("github.appIdMissing")}</FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={ids.key}>{t("github.key")}</FieldLabel>
              <Input
                id={ids.key}
                className="max-w-105"
                name="private_key"
                type="file"
                accept=".pem,application/x-pem-file"
                aria-describedby={ids.keyHint}
                aria-invalid={missing === "key" || undefined}
                onChange={() => {
                  if (missing === "key") setMissing(null);
                }}
              />
              <FieldDescription id={ids.keyHint}>
                {t("github.keyHint")}
              </FieldDescription>
              {missing === "key" ? (
                <FieldError>{t("github.keyMissing")}</FieldError>
              ) : null}
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                aria-disabled={
                  save.isPending || (!rotate && appRole === undefined) || undefined
                }
              >
                {t(rotate ? "github.rotate.submit" : "github.addDialog.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Each App's disconnect, last on the page; focus lands on the zone after. */
function Disconnect({
  apps,
  userLinked,
  focus,
  onDone,
  onOutcome,
}: {
  readonly apps: readonly AppView[];
  readonly userLinked: boolean;
  readonly focus: boolean;
  readonly onDone: (role: GitHubAppRole) => void;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const titleId = useId();
  const [target, setTarget] = useState<AppView | null>(null);
  useEffect(() => {
    if (!focus) return;
    const title = document.getElementById(titleId);
    title?.setAttribute("tabindex", "-1");
    title?.focus();
  }, [focus, titleId]);

  const remove = useMutation<unknown, ApiError, AppView>({
    mutationFn: (app) =>
      unwrap(
        client.DELETE("/v1/workspaces/{id}/github-apps/{role}", {
          params: { path: { id: workspaceId, role: app.role } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: (_, app) => {
      setTarget(null);
      onOutcome({
        kind: "notice",
        text: t("github.disconnect.done", { name: app.name }),
      });
      onDone(app.role);
    },
    onError: (error, app) => {
      setTarget(null);
      // Another tab or person disconnected it first: gone either way.
      if (isApiError(error, "NOT_FOUND")) {
        onOutcome({
          kind: "notice",
          text: t("github.disconnect.done", { name: app.name }),
        });
        onDone(app.role);
        return;
      }
      onOutcome({
        kind: "error",
        text: storeOff(error)
          ? t("workspace.tokenStoreUnavailable")
          : refusalText(t, error, "workspace.manage", role),
      });
    },
  });

  if (apps.length === 0) return null;
  const consequence = (app: AppView) =>
    [
      t(`github.disconnect.${app.role}Hint`),
      app.role === "author" && userLinked ? t("github.disconnect.userLink") : "",
    ]
      .filter(Boolean)
      .join(" ");
  return (
    <DangerZone title={t("workspace.danger")} titleId={titleId}>
      {apps.map((app) => (
        <DangerZoneRow
          key={app.role}
          title={t("github.disconnect.row", { name: app.name })}
          description={consequence(app)}
          actionLabel={t("github.disconnect.action")}
          actionName={t("github.disconnect.row", { name: app.name })}
          onAction={() => setTarget(app)}
        />
      ))}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next) setTarget(null);
        }}
        title={t("github.disconnect.title", { name: target?.name ?? "" })}
        consequence={target ? consequence(target) : ""}
        confirmLabel={t("github.disconnect.action")}
        cancelLabel={t("common.cancel")}
        target={target?.name}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (target && !remove.isPending) remove.mutate(target);
        }}
      />
    </DangerZone>
  );
}
