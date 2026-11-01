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
  GitHubAppRole,
  GitHubCeiling,
  GitHubSettingsResponse,
  PutGitHubSettingsRequest,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  ConfirmDialog,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  RowList,
  SettingRow,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { GitPullRequest, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import { IconTile } from "../components/icon-tile.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { isMessageKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import {
  type OfferedFeature,
  type PermissionRow,
  permissionTable,
  ROLE_FEATURES,
} from "./github-permission-table.ts";
import type { OnOutcome } from "./workspace-settings.tsx";

export const META = "text-caption text-subtle-foreground";
const STATUS = `${META} min-w-14 text-right`;

export const githubSettingsKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-settings");

export function useGitHubSettings(): UseQueryResult<GitHubSettingsResponse> {
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
    enabled: workspaceId !== "",
  });
}

/** The tile an App is marked with, as tall as the two lines beside it. */
export function AppTile({ role }: { readonly role: GitHubAppRole }) {
  return role === "author" ? (
    <IconTile icon={GitPullRequest} hue="slate" size="two-line" />
  ) : (
    <IconTile icon={ShieldCheck} hue="blue" size="two-line" />
  );
}

export const levelText = (t: Translate, level: GitHubAppPermissionLevel) =>
  t(`github.permissions.level.${level}`);

// A permission this build has no words for is shown as GitHub names it.
export function permissionName(t: Translate, name: string): string {
  const key = `github.permissions.name.${name}`;
  return isMessageKey(key) ? t(key) : name;
}

const pick = (from: GitHubCeiling, role: GitHubAppRole) =>
  Object.fromEntries(
    ROLE_FEATURES[role].map((feature) => [feature, from[feature]]),
  ) as Partial<GitHubCeiling>;

export type CeilingDraft = ReturnType<typeof useCeilingDraft>;

/**
 * The switches as the page shows them: one draft over the saved ceiling,
 * read by every role section and permission table, saved and reverted a
 * role at a time. Checks and issues, which no switch shows, and the other
 * role's draft go back in the PUT as saved.
 */
export function useCeilingDraft(
  settings: UseQueryResult<GitHubSettingsResponse>,
  onOutcome: OnOutcome,
) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const [draft, setDraft] = useState<GitHubCeiling | null>(null);
  // Switches someone else changed under a draft a save then found stale.
  const [theirs, setTheirs] = useState<readonly OfferedFeature[]>([]);
  const saved = settings.data?.ceiling;
  const shown = draft ?? saved;

  const changedOf = (appRole: GitHubAppRole): OfferedFeature[] =>
    draft === null || saved === undefined
      ? []
      : ROLE_FEATURES[appRole].filter(
          (feature) => draft[feature] !== saved[feature],
        );

  const save = useMutation<
    GitHubSettingsResponse,
    ApiError,
    PutGitHubSettingsRequest & { readonly appRole: GitHubAppRole }
  >({
    mutationFn: ({ ceiling, revision }) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-settings", {
          params: { path: { id: workspaceId } },
          body: { ceiling, revision },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: (next, { appRole }) => {
      queryClient.setQueryData(githubSettingsKey(client, workspaceId), next);
      setDraft((was) => (was ? { ...was, ...pick(next.ceiling, appRole) } : was));
      setTheirs([]);
      onOutcome({ kind: "notice", text: t("github.ceiling.saved") });
    },
    onError: async (error, { appRole }) => {
      if (isApiError(error, "REVISION_CONFLICT")) {
        // The draft stays; the switches someone else moved are marked.
        const fresh = (await settings.refetch()).data?.ceiling;
        if (fresh && draft) {
          setTheirs(
            ROLE_FEATURES[appRole].filter(
              (feature) => fresh[feature] !== draft[feature],
            ),
          );
        }
        onOutcome({ kind: "error", text: t("github.ceiling.conflict") });
        return;
      }
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "workspace.manage", role),
      });
    },
  });

  return {
    saved,
    shown,
    saving: save.isPending,
    theirs,
    changedOf,
    toggle(feature: OfferedFeature, on: boolean) {
      if (shown === undefined) return;
      setDraft({ ...shown, [feature]: on });
    },
    revert(appRole: GitHubAppRole) {
      if (saved === undefined) return;
      setDraft((was) => (was ? { ...was, ...pick(saved, appRole) } : was));
      setTheirs([]);
    },
    save(appRole: GitHubAppRole) {
      const data = settings.data;
      if (save.isPending || draft === null || data === undefined) return;
      save.mutate({
        appRole,
        ceiling: { ...data.ceiling, ...pick(draft, appRole) },
        revision: data.revision,
      });
    },
  };
}

const ROLE_BASE: Record<GitHubAppRole, boolean> = {
  author: true,
  reviewer: false,
};

/**
 * What a role's App lets agents turn on, as switches over the workspace's
 * ceiling. A change shows "unsaved" on its row and a save strip under the
 * list, which saves this role's switches only; lowering one agents use
 * asks first.
 */
export function FeatureList({
  appRole,
  settings,
  ceiling,
  canManage,
  hasApp,
}: {
  readonly appRole: GitHubAppRole;
  readonly settings: UseQueryResult<GitHubSettingsResponse>;
  readonly ceiling: CeilingDraft;
  readonly canManage: boolean;
  /** A switch with no App to serve it stays off; one on can be turned off. */
  readonly hasApp: boolean;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const data = settings.data;
  const shown = ceiling.shown;
  const changed = ceiling.changedOf(appRole);
  const lowered = changed.filter(
    (feature) => ceiling.saved?.[feature] && (data?.agents_using[feature] ?? 0) > 0,
  );
  const using = (feature: OfferedFeature) => data?.agents_using[feature] ?? 0;
  const lowerList = lowered
    .map((feature) =>
      t("github.ceiling.lowerItem", {
        feature: t(`github.ceiling.feature.${feature}`),
        count: using(feature),
      }),
    )
    .join(", ");

  const body = settings.isPending ? (
    <div className="p-4">
      <Skeleton width="50%" />
    </div>
  ) : settings.isError ? (
    <div className="p-4">
      <LoadFailure
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    </div>
  ) : (
    <RowList
      variant="joined"
      className="rounded-none border-0 bg-transparent"
      aria-label={t(`github.role.${appRole}.features`)}
    >
      {ROLE_BASE[appRole] ? (
        <SettingRow
          title={t("github.ceiling.base")}
          badge={<Badge>{t("github.ceiling.baseBadge")}</Badge>}
          description={t("github.ceiling.baseHint")}
          meta={<div className={META}>{t("github.ceiling.baseMeta")}</div>}
          actions={<div className={STATUS}>{t("github.ceiling.always")}</div>}
        />
      ) : null}
      {ROLE_FEATURES[appRole].map((feature) => {
        const on = shown?.[feature] ?? false;
        const title = t(`github.ceiling.feature.${feature}`);
        return (
          <SettingRow
            key={feature}
            title={title}
            badge={
              ceiling.theirs.includes(feature) ? (
                <Badge variant="amber">{t("github.ceiling.theirs")}</Badge>
              ) : changed.includes(feature) ? (
                <Badge variant="blue">{t("github.ceiling.unsaved")}</Badge>
              ) : undefined
            }
            description={t(`github.ceiling.feature.${feature}Hint`)}
            meta={
              <div className={META}>
                {t("github.ceiling.agentsUsing", { count: using(feature) })}
              </div>
            }
            status={
              <div aria-hidden="true" className={STATUS}>
                {t(on ? "github.ceiling.allowed" : "github.ceiling.denied")}
              </div>
            }
            control={
              <Switch
                aria-label={title}
                checked={on}
                disabled={
                  !canManage ||
                  ceiling.saving ||
                  data === undefined ||
                  (!hasApp && !on)
                }
                onCheckedChange={(next) => ceiling.toggle(feature, next)}
              />
            }
          />
        );
      })}
    </RowList>
  );

  return (
    <Card flush>
      {body}
      {canManage && changed.length > 0 ? (
        <CardFooter variant="form">
          <div className={META}>
            {t("github.ceiling.footChanged", {
              role: t(`github.role.${appRole}.title`),
              count: changed.length,
            })}
            {lowered.length > 0
              ? ` ${t("github.ceiling.footLowered", { list: lowerList })}`
              : ""}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => ceiling.revert(appRole)}
            >
              {t("github.ceiling.revert")}
            </Button>
            {/* aria-disabled, not disabled: a disabled button drops its focus. */}
            <Button
              type="button"
              size="sm"
              className="aria-disabled:opacity-45"
              aria-disabled={ceiling.saving || undefined}
              onClick={() => {
                if (ceiling.saving) return;
                if (lowered.length > 0) setConfirming(true);
                else ceiling.save(appRole);
              }}
            >
              {t("github.ceiling.save")}
            </Button>
          </div>
        </CardFooter>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("github.ceiling.lowerTitle")}
        // Per feature: one agent may turn on several, so the counts do not add.
        consequence={t("github.ceiling.lowerBody", { features: lowerList })}
        confirmLabel={t("github.ceiling.lowerConfirm")}
        cancelLabel={t("common.cancel")}
        busy={ceiling.saving}
        onConfirm={() => {
          setConfirming(false);
          ceiling.save(appRole);
        }}
      />
    </Card>
  );
}

const BADGE_TONE = {
  missing: "amber",
  short: "amber",
  beyond: "red",
  unused: "gray",
  ok: "green",
  pending: "amber",
} as const;

/**
 * An App's permissions against what its role needs under the switches as
 * shown, and what the picked installation approved. Rows keep one order;
 * a row the unsaved switches changed is tinted and said so.
 */
export function PermissionTable({
  appRole,
  appName,
  permissions,
  approved,
  ceiling,
  saved,
  onRetry,
}: {
  readonly appRole: GitHubAppRole;
  readonly appName: string;
  /** Null when GitHub has not given them. */
  readonly permissions: GitHubAppPermissions | null;
  readonly approved: GitHubAppPermissions | null;
  readonly ceiling: GitHubCeiling;
  readonly saved: GitHubCeiling;
  readonly onRetry?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const heading = (
    <h4 id={headingId} className="m-0 font-semibold text-control">
      {t("github.permissions.title")}
      <span className="sr-only"> — {appName}</span>
    </h4>
  );
  if (permissions === null) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {heading}
        <p className={`m-0 ${META}`}>{t("github.permissions.unread")}</p>
        {onRetry ? (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {t("github.repos.retry")}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  const table = permissionTable({
    role: appRole,
    app: permissions,
    approved,
    ceiling,
    saved,
  });
  const short = (level: GitHubAppPermissionLevel | null) =>
    level ? levelText(t, level) : "—";
  const granted = (row: PermissionRow) =>
    row.approval === "unknown" ? t("github.unknown") : short(row.granted);
  const none = (label: string) => (
    <span className="text-subtle-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
  const level = (value: GitHubAppPermissionLevel | null) =>
    value === null ? none(t("github.permissions.levelNone")) : levelText(t, value);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {heading}
      <GridTable
        aria-labelledby={headingId}
        columns="minmax(0,1fr) 56px 56px 56px 112px"
        narrowAt={480}
        narrowColumns="minmax(0,1fr) 112px"
        className="rounded-card border"
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            {t("github.permissions.col.name")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("github.permissions.col.need")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("github.permissions.col.app")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("github.permissions.col.install")}
          </GridTableColumnHeader>
          <GridTableColumnHeader align="end">
            {t("github.permissions.col.status")}
          </GridTableColumnHeader>
        </GridTableHeader>
        {table.rows.map((row) => (
          <GridTableRow
            key={row.name}
            data-status={row.status}
            data-approval={row.approval}
            data-changed={row.changed || undefined}
            className={
              row.changed ? "bg-(color:--ap-tone-progress-bg)" : undefined
            }
          >
            <GridTableCell>
              <span className="flex min-w-0 flex-col">
                <span className="[overflow-wrap:anywhere]" title={row.name}>
                  {permissionName(t, row.name)}
                  {row.changed ? (
                    <span className="sr-only">
                      {" "}
                      {t("github.permissions.changedRow")}
                    </span>
                  ) : null}
                </span>
                {/* Below 480px the need, App and installation columns fold here. */}
                <span
                  className={`[overflow-wrap:anywhere] [@container(width>=480px)]:hidden ${META}`}
                >
                  {t("github.permissions.folded", {
                    need: short(row.need),
                    app: short(row.app),
                    granted: granted(row),
                  })}
                </span>
              </span>
            </GridTableCell>
            <GridTableCell hideNarrow>{level(row.need)}</GridTableCell>
            <GridTableCell hideNarrow>{level(row.app)}</GridTableCell>
            <GridTableCell hideNarrow>
              {row.approval === "unknown" ? (
                none(t("github.unknown"))
              ) : row.approval === "pending" ? (
                <span className="text-(color:--ap-tone-caution-fg)">
                  {short(row.granted)}
                  <span className="sr-only">
                    {" "}
                    {t("github.permissions.pendingCell")}
                  </span>
                </span>
              ) : (
                level(row.granted)
              )}
            </GridTableCell>
            <GridTableCell align="end">
              <Badge variant={BADGE_TONE[row.badge]}>
                {t(`github.permissions.status.${row.badge}`)}
              </Badge>
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
      <output className={`m-0 block ${META}`}>
        {table.changed.length > 0
          ? t("github.permissions.changedNote", {
              list: table.changed
                .map((row) => `${permissionName(t, row.name)} ${short(row.need)}`)
                .join(", "),
            })
          : null}
      </output>
    </div>
  );
}
