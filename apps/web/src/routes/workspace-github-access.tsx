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
import {
  GITHUB_APP_PERMISSION_GUIDANCE,
  githubAppWarnings,
} from "@werft-ai/core/forms";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  RowListItem,
  SettingRow,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { isMessageKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import {
  type OnOutcome,
  ReadOnlyMark,
  SettingsCard,
} from "./workspace-settings.tsx";

type Feature = keyof GitHubCeiling;

// The mockup's order (screen C): the reviewer's feature, then the author's.
const FEATURES: readonly Feature[] = [
  "review",
  "actions",
  "checks",
  "issues",
  "workflows",
];

// What every agent holds without the ceiling; the rest of the guidance is optional.
const DEFAULTS: ReadonlySet<string> = new Set([
  "contents",
  "pull_requests",
  "metadata",
]);

const STATUS = "text-caption text-subtle-foreground min-w-14 text-right";
const META = "text-caption text-subtle-foreground";

export const githubSettingsKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-settings");

/**
 * The App permission table and the agents' ceiling. `fresh` is the author
 * App's permissions as GET …/github-app just read them (owners and admins);
 * without it the settings' last read stands.
 */
export function GitHubAccess({
  fresh,
  onOutcome,
}: {
  readonly fresh: GitHubAppPermissions | null | undefined;
  readonly onOutcome: OnOutcome;
}) {
  const { client } = useAgentPlatform();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const settings = useQuery({
    queryKey: githubSettingsKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-settings", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "",
  });
  const author = settings.data?.apps.author;
  const permissions =
    fresh !== undefined ? fresh : author ? author.permissions : undefined;
  return (
    <>
      {permissions === undefined ? null : (
        <AppPermissions permissions={permissions} />
      )}
      <Ceiling
        settings={settings}
        permissions={permissions ?? null}
        onOutcome={onOutcome}
      />
    </>
  );
}

const levelText = (t: Translate, level: GitHubAppPermissionLevel) =>
  t(`github.permissions.level.${level}`);

// A permission this build has no words for is shown as GitHub names it.
function permissionName(t: Translate, name: string): string {
  const key = `github.permissions.name.${name}`;
  return isMessageKey(key) ? t(key) : name;
}

function AppPermissions({
  permissions,
}: {
  readonly permissions: GitHubAppPermissions | null;
}) {
  const { t } = useI18n();
  const guidance = GITHUB_APP_PERMISSION_GUIDANCE.author;
  const warnings = githubAppWarnings("author", permissions);
  const names = [
    ...Object.keys(guidance),
    ...Object.keys(permissions ?? {})
      .filter((name) => guidance[name] === undefined)
      .sort(),
  ];
  return (
    <SettingsCard
      title={t("github.permissions.title")}
      description={t("github.permissions.hint")}
      rows={
        permissions === null ? (
          <SettingRow title={t("github.permissions.unread")} />
        ) : (
          names.map((name) => {
            const guided = guidance[name];
            const level = permissions[name];
            const wide = warnings.some((item) => item.permission === name);
            return (
              <SettingRow
                key={name}
                title={permissionName(t, name)}
                badge={<Badge variant="mono">{name}</Badge>}
                description={
                  guided === undefined
                    ? t("github.permissions.notGuided")
                    : t(
                        DEFAULTS.has(name)
                          ? "github.permissions.guidedDefault"
                          : "github.permissions.guidedOptional",
                        { level: levelText(t, guided) },
                      )
                }
                meta={
                  <div>
                    {level === undefined ? (
                      <Badge variant={DEFAULTS.has(name) ? "amber" : "gray"}>
                        {t("github.permissions.appNone")}
                      </Badge>
                    ) : wide ? (
                      <Badge variant="red">
                        {t("github.permissions.appWide", {
                          level: levelText(t, level),
                        })}
                      </Badge>
                    ) : (
                      <Badge variant="green">
                        {t("github.permissions.app", {
                          level: levelText(t, level),
                        })}
                      </Badge>
                    )}
                  </div>
                }
              />
            );
          })
        )
      }
    >
      {warnings.length > 0 ? (
        <Alert variant="amber">
          <AlertTitle>{t("github.permissions.wideTitle")}</AlertTitle>
          <AlertDescription>
            {t("github.permissions.wideBody", {
              list: warnings
                .map((item) => `${item.permission} ${levelText(t, item.level)}`)
                .join(", "),
            })}
          </AlertDescription>
        </Alert>
      ) : null}
    </SettingsCard>
  );
}

/** The App a feature's token comes from must hold this, or the feature never mints. */
function appLacks(
  feature: Feature,
  permissions: GitHubAppPermissions | null,
  reviewer: GitHubSettingsResponse["apps"]["reviewer"] | undefined,
): "author" | "reviewer" | null {
  if (feature === "review") return reviewer ? null : "reviewer";
  if (permissions === null) return null;
  const level = permissions[feature];
  return level === "write" || level === "admin" ? null : "author";
}

/**
 * What agents may turn on beyond writing a PR. Owners and admins change it,
 * the rule the execution-profile ceiling keeps; lowering asks first, since a
 * running release loses the feature at its next token.
 */
function Ceiling({
  settings,
  permissions,
  onOutcome,
}: {
  readonly settings: UseQueryResult<GitHubSettingsResponse>;
  readonly permissions: GitHubAppPermissions | null;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const [draft, setDraft] = useState<GitHubCeiling | null>(null);
  const [confirming, setConfirming] = useState(false);
  const hintId = useId();
  const data = settings.data;
  const shown = draft ?? data?.ceiling;
  const changed = FEATURES.filter(
    (feature) =>
      draft !== null && data && draft[feature] !== data.ceiling[feature],
  );
  const lowered = changed.filter((feature) => data?.ceiling[feature]);

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
    if (save.isPending || draft === null || !data) return;
    save.mutate({ ceiling: draft, revision: data.revision });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed.length === 0) return;
    if (lowered.length > 0) setConfirming(true);
    else send();
  };

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
      <SettingRow
        title={t("github.ceiling.base")}
        badge={<Badge>{t("github.ceiling.baseBadge")}</Badge>}
        description={t("github.ceiling.baseHint")}
        actions={<div className={STATUS}>{t("github.ceiling.always")}</div>}
      />
      {FEATURES.map((feature) => {
        const on = shown?.[feature] ?? false;
        const lacks = appLacks(feature, permissions, data?.apps.reviewer);
        return (
          <SettingRow
            key={feature}
            title={t(`github.ceiling.feature.${feature}`)}
            description={t(`github.ceiling.feature.${feature}Hint`)}
            meta={
              <>
                <div className={META}>
                  {t("github.ceiling.agentsUsing", {
                    count: data?.agents_using[feature] ?? 0,
                  })}
                </div>
                {lacks ? (
                  <div className="text-caption text-(color:--ap-tone-caution-fg)">
                    {t(
                      lacks === "reviewer"
                        ? "github.ceiling.noReviewer"
                        : "github.ceiling.appLacks",
                    )}
                  </div>
                ) : null}
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
                disabled={!canManage || save.isPending}
                onCheckedChange={(next) =>
                  setDraft({ ...(shown as GitHubCeiling), [feature]: next })
                }
              />
            }
          />
        );
      })}
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
