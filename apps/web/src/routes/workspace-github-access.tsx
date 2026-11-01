import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  GitHubAppPermissionLevel,
  GitHubAppPermissions,
  GitHubCeiling,
  GitHubSettingsResponse,
  PutGitHubSettingsRequest,
} from "@werft-ai/contracts";
import { githubAppWarnings } from "@werft-ai/core/forms";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  RowListItem,
  SettingRow,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { GitPullRequest, ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { IconTile } from "../components/icon-tile.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { isMessageKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import {
  BASE_NEED,
  FEATURE_NEED,
  firstShortfall,
  OFFERED_FEATURES,
  type OfferedFeature,
  type PermissionRow,
  permissionRows,
  REVIEW_NEED,
} from "./github-permission-table.ts";
import {
  type OnOutcome,
  ReadOnlyMark,
  SettingsCard,
} from "./workspace-settings.tsx";

const STATUS = "text-caption text-subtle-foreground min-w-14 text-right";
const META = "text-caption text-subtle-foreground";

/** The anchors the summary and the ceiling's group heads link to. */
export const GITHUB_APP_ANCHOR = "github-app";
export const GITHUB_REVIEWER_ANCHOR = "github-reviewer";

export const githubSettingsKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-settings");

/** `enabled` false keeps a late-mounted reader from fetching the settings again. */
export function useGitHubSettings(
  enabled = true,
): UseQueryResult<GitHubSettingsResponse> {
  const { client } = useAgentPlatform();
  const workspaceId = useMe()?.workspace?.id ?? "";
  return useQuery({
    queryKey: githubSettingsKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-settings", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: enabled && workspaceId !== "",
  });
}

/** The tile an App is marked with wherever the screen names it. */
export function AppTile({ app }: { readonly app: "author" | "reviewer" }) {
  return app === "author" ? (
    <IconTile icon={GitPullRequest} hue="slate" />
  ) : (
    <IconTile icon={ShieldCheck} hue="blue" />
  );
}

export const levelText = (t: Translate, level: GitHubAppPermissionLevel) =>
  t(`github.permissions.level.${level}`);

// A permission this build has no words for is shown as GitHub names it.
export function permissionName(t: Translate, name: string): string {
  const key = `github.permissions.name.${name}`;
  return isMessageKey(key) ? t(key) : name;
}

/** "Contents · Pull requests write": names joined, the level said once. */
function needText(t: Translate, need: GitHubAppPermissions): string {
  const levels = new Set(Object.values(need));
  if (levels.size === 1) {
    return `${Object.keys(need)
      .map((name) => permissionName(t, name))
      .join(
        " · ",
      )} ${levelText(t, [...levels][0] as GitHubAppPermissionLevel)}`;
  }
  return Object.entries(need)
    .map(([name, level]) => `${permissionName(t, name)} ${levelText(t, level)}`)
    .join(" · ");
}

function purposeText(t: Translate, row: PermissionRow, ceiling: GitHubCeiling) {
  if (row.feature === "base") return t("github.permissions.use.base");
  if (row.feature === "actions" || row.feature === "workflows") {
    return t(
      ceiling[row.feature]
        ? `github.permissions.use.${row.feature}`
        : `github.permissions.use.${row.feature}Off`,
    );
  }
  return t("github.permissions.use.none");
}

const STATUS_BADGE = {
  missing: "amber",
  short: "amber",
  wide: "amber",
  ok: "green",
} as const;

/**
 * The author App's permissions next to what the platform needs of it now,
 * one row a permission, problems first.
 */
export function AppPermissionTable({
  permissions,
  ceiling,
}: {
  readonly permissions: GitHubAppPermissions | null;
  readonly ceiling: GitHubCeiling | undefined;
}) {
  const { t } = useI18n();
  const headingId = useId();
  if (permissions === null || ceiling === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <h3 id={headingId} className="m-0 font-semibold text-control">
          {t("github.permissions.title")}
        </h3>
        <p className={`m-0 ${META}`}>
          {permissions === null
            ? t("github.permissions.unread")
            : t("github.permissions.waiting")}
        </p>
      </div>
    );
  }
  // Beyond what the platform could ever use: red, and the alert says why.
  const beyond = new Set(
    githubAppWarnings("author", permissions).map((item) => item.permission),
  );
  const rows = permissionRows(permissions, ceiling);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="m-0 font-semibold text-control">
        {t("github.permissions.title")}{" "}
        <span className={`${META} font-normal`}>
          · {t("github.permissions.hint")}
        </span>
      </h3>
      <GridTable
        aria-labelledby={headingId}
        columns="minmax(0,1fr) 64px 64px 112px"
        narrowAt={480}
        narrowColumns="minmax(0,1fr) 48px 48px 96px"
        className="rounded-card border"
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            {t("github.permissions.col.name")}
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            {t("github.permissions.col.need")}
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            {t("github.permissions.col.app")}
          </GridTableColumnHeader>
          <GridTableColumnHeader align="end">
            {t("github.permissions.col.status")}
          </GridTableColumnHeader>
        </GridTableHeader>
        {rows.map((row) => {
          const wideRed = row.status === "wide" && beyond.has(row.name);
          return (
            <GridTableRow key={row.name} data-status={row.status}>
              <GridTableCell>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {permissionName(t, row.name)}
                  </span>
                  <span className="truncate font-mono text-caption text-subtle-foreground">
                    {row.name} · {purposeText(t, row, ceiling)}
                  </span>
                </span>
              </GridTableCell>
              <GridTableCell>
                <Level t={t} level={row.need} />
              </GridTableCell>
              <GridTableCell>
                <Level t={t} level={row.app} />
              </GridTableCell>
              <GridTableCell align="end">
                <Badge variant={wideRed ? "red" : STATUS_BADGE[row.status]}>
                  {t(`github.permissions.status.${row.status}`)}
                </Badge>
              </GridTableCell>
            </GridTableRow>
          );
        })}
      </GridTable>
      <p className={`m-0 ${META}`}>{t("github.permissions.foot")}</p>
      {beyond.size > 0 ? (
        <Alert variant="amber">
          <AlertTitle>{t("github.permissions.wideTitle")}</AlertTitle>
          <AlertDescription>
            {t("github.permissions.wideBody", {
              list: [...beyond]
                .sort()
                .map(
                  (name) =>
                    `${name} ${levelText(t, permissions[name] as GitHubAppPermissionLevel)}`,
                )
                .join(", "),
            })}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function Level({
  t,
  level,
}: {
  readonly t: Translate;
  readonly level: GitHubAppPermissionLevel | null;
}) {
  if (level === null) {
    return (
      <span className="text-subtle-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("github.permissions.levelNone")}</span>
      </span>
    );
  }
  return <span>{levelText(t, level)}</span>;
}

type AppSide = {
  readonly name: string | null;
  readonly permissions: GitHubAppPermissions | null;
} | null;

/** What a feature asks its App for, and what that App holds of it. */
function NeedLine({
  t,
  need,
  app,
}: {
  readonly t: Translate;
  readonly need: GitHubAppPermissions;
  readonly app: AppSide;
}) {
  const short = app ? firstShortfall(need, app.permissions) : null;
  return (
    <div className={META}>
      {t("github.ceiling.needLabel")}: {needText(t, need)}
      {app?.permissions ? (
        short ? (
          <span className="text-(color:--ap-tone-caution-fg)">
            {" · "}
            {short.held
              ? t("github.ceiling.heldShort", {
                  level: levelText(t, short.held),
                })
              : t("github.ceiling.heldNone")}
          </span>
        ) : (
          ` · ${t("github.ceiling.heldOk")}`
        )
      ) : null}
    </div>
  );
}

function GroupHead({
  app,
  title,
  aside,
}: {
  readonly app: "author" | "reviewer";
  readonly title: string;
  readonly aside: ReactNode;
}) {
  return (
    <RowListItem className="flex items-center gap-2 bg-surface-sunken py-2 font-medium text-caption">
      <AppTile app={app} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {aside}
    </RowListItem>
  );
}

/**
 * What agents may turn on beyond writing a PR, grouped by the App whose
 * permissions each feature's token comes from. Owners and admins change it,
 * the rule the execution-profile ceiling keeps; lowering asks first, since a
 * running release loses the feature at its next token.
 */
export function Ceiling({
  settings,
  author,
  reviewer,
  onOutcome,
}: {
  readonly settings: UseQueryResult<GitHubSettingsResponse>;
  /** The author App as last read; null when none is registered. */
  readonly author: AppSide;
  readonly reviewer: AppSide;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  // The draft keeps the revision it was made on: a refetch while editing
  // must not let the save overwrite a change this screen never showed.
  const [draft, setDraft] = useState<{
    readonly ceiling: GitHubCeiling;
    readonly base: GitHubSettingsResponse;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const hintId = useId();
  const data = settings.data;
  const shown = draft?.ceiling ?? data?.ceiling;
  const changed = OFFERED_FEATURES.filter(
    (feature) =>
      draft !== null && draft.ceiling[feature] !== draft.base.ceiling[feature],
  );
  const lowered = changed.filter((feature) => draft?.base.ceiling[feature]);

  const save = useMutation<
    GitHubSettingsResponse,
    ApiError,
    PutGitHubSettingsRequest
  >({
    mutationFn: (body) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-settings", {
          params: { path: { id: workspaceId } },
          body,
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: (next) => {
      setConfirming(false);
      queryClient.setQueryData(githubSettingsKey(client, workspaceId), next);
      setDraft(null);
      onOutcome({ kind: "notice", text: t("github.ceiling.saved") });
    },
    onError: async (error) => {
      setConfirming(false);
      if (isApiError(error, "REVISION_CONFLICT")) {
        // The screen shows what is saved now; the owner decides again on it.
        setDraft(null);
        await settings.refetch();
        onOutcome({ kind: "error", text: t("github.ceiling.conflict") });
        return;
      }
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      });
    },
  });

  const send = () => {
    if (save.isPending || draft === null) return;
    save.mutate({ ceiling: draft.ceiling, revision: draft.base.revision });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed.length === 0) return;
    if (lowered.length > 0) setConfirming(true);
    else send();
  };

  const featureRow = (feature: OfferedFeature) => {
    const on = shown?.[feature] ?? false;
    const app = feature === "review" ? reviewer : author;
    const need = feature === "review" ? REVIEW_NEED : FEATURE_NEED[feature];
    const short =
      app === null ? null : firstShortfall(need, app.permissions ?? null);
    // A review needs a reviewer App; one already on can still be turned off.
    const locked = feature === "review" && reviewer === null && !on;
    return (
      <SettingRow
        key={feature}
        title={t(`github.ceiling.feature.${feature}`)}
        badge={
          short ? (
            <Badge variant="amber">{t("github.ceiling.appShort")}</Badge>
          ) : feature === "review" ? (
            <Badge>{t("github.reviewer.advanced")}</Badge>
          ) : undefined
        }
        description={t(`github.ceiling.feature.${feature}Hint`)}
        meta={
          <>
            <NeedLine t={t} need={need} app={app} />
            <div className={META}>
              {t("github.ceiling.agentsUsing", {
                count: data?.agents_using[feature] ?? 0,
              })}
            </div>
          </>
        }
        status={
          <div aria-hidden="true" className={STATUS}>
            {t(on ? "github.ceiling.allowed" : "github.ceiling.denied")}
          </div>
        }
        control={
          <Switch
            checked={on}
            aria-describedby={canManage ? undefined : hintId}
            disabled={
              !canManage || save.isPending || data === undefined || locked
            }
            onCheckedChange={(next) => {
              const base = draft?.base ?? data;
              if (base === undefined) return;
              setDraft({
                base,
                ceiling: {
                  ...(draft?.ceiling ?? base.ceiling),
                  [feature]: next,
                },
              });
            }}
          />
        }
      />
    );
  };

  const appLink = (anchor: string) => (
    <a
      href={`#${anchor}`}
      className="shrink-0 font-medium text-link underline-offset-2 hover:underline"
    >
      {t("github.ceiling.viewApp")}
    </a>
  );

  const rows = settings.isPending ? (
    <RowListItem>
      <Skeleton width="50%" />
    </RowListItem>
  ) : settings.isError ? (
    <RowListItem>
      <LoadFailure
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    </RowListItem>
  ) : (
    <>
      <GroupHead
        app="author"
        title={
          author?.name
            ? t("github.ceiling.groupAuthor", { name: author.name })
            : t("github.ceiling.groupAuthorUnset")
        }
        aside={author ? appLink(GITHUB_APP_ANCHOR) : null}
      />
      <SettingRow
        title={t("github.ceiling.base")}
        badge={<Badge>{t("github.ceiling.baseBadge")}</Badge>}
        description={t("github.ceiling.baseHint")}
        meta={<NeedLine t={t} need={BASE_NEED} app={author} />}
        actions={<div className={STATUS}>{t("github.ceiling.always")}</div>}
      />
      {featureRow("actions")}
      {featureRow("workflows")}
      <GroupHead
        app="reviewer"
        title={t("github.ceiling.groupReviewer")}
        aside={
          reviewer ? (
            appLink(GITHUB_REVIEWER_ANCHOR)
          ) : (
            <Badge>{t("github.unset")}</Badge>
          )
        }
      />
      {featureRow("review")}
    </>
  );

  return (
    <>
      <SettingsCard
        title={t("github.ceiling.title")}
        description={t("github.ceiling.hint")}
        rows={rows}
        onSubmit={submit}
        foot={
          canManage ? (
            <>
              <div className={META}>{t("github.ceiling.receiptNote")}</div>
              <div className="flex gap-2">
                {changed.length > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraft(null)}
                  >
                    {t("github.ceiling.revert")}
                  </Button>
                ) : null}
                {/* aria-disabled, not disabled: a disabled button drops its focus. */}
                <Button
                  type="submit"
                  size="sm"
                  className="aria-disabled:opacity-45"
                  aria-disabled={
                    changed.length === 0 || save.isPending || undefined
                  }
                >
                  {t("workspace.save")}
                </Button>
              </div>
            </>
          ) : (
            <div id={hintId} className="flex flex-wrap items-center gap-2">
              <ReadOnlyMark />
              <div className={META}>
                {permissionReason(t, "workspace.manage", role)}
              </div>
            </div>
          )
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("github.ceiling.lowerTitle")}
        // Per feature: one agent may turn on several, so the counts do not add.
        consequence={t("github.ceiling.lowerBody", {
          features: lowered
            .map((feature) =>
              t("github.ceiling.lowerItem", {
                feature: t(`github.ceiling.feature.${feature}`),
                count: data?.agents_using[feature] ?? 0,
              }),
            )
            .join(", "),
        })}
        confirmLabel={t("github.ceiling.lowerConfirm")}
        cancelLabel={t("common.cancel")}
        busy={save.isPending}
        onConfirm={send}
      />
    </>
  );
}
