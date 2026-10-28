import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  InstallationProfileState,
  ProfileSummary,
  WorkspaceProfileState,
} from "@werft-ai/contracts";
import { workspaceProfileId } from "@werft-ai/core/forms";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  buttonVariants,
  cn,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Page,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
} from "@werft-ai/ui";
import { ChevronDown, ChevronRight, Lock, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { profilesQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { pickable } from "../components/profile-options.tsx";
import { useI18n } from "../i18n/i18n.tsx";

// Name, version, kind, base, default model, permission mode, state; a phone
// keeps the name and the state, and the name cell says the kind.
const COLUMNS = [
  "minmax(0,1.6fr) 64px 112px minmax(0,1fr) minmax(0,1fr) 128px 152px",
  "minmax(0,1fr) 128px",
] as const;
const META = "text-caption text-muted-foreground";

export type ProfileState = WorkspaceProfileState | InstallationProfileState;

export const STATE_BADGE: Record<ProfileState, "green" | "red" | "gray"> = {
  usable: "green",
  base_changed: "red",
  base_missing: "red",
  retired: "gray",
  base_retired: "gray",
  base_blocked: "red",
  blocked: "red",
  connection_missing: "red",
  unattended_off: "red",
  definition_drift: "red",
  runtime_unsupported: "red",
};

type Filter = "all" | "installation" | "workspace";

export const stateOf = (profile: ProfileSummary): ProfileState =>
  profile.workspace?.state ?? profile.installation?.state ?? "usable";

/** What a profile is called: an imported ceiling has only its id. */
export const profileName = (profile: ProfileSummary): string =>
  profile.workspace?.name ?? profile.installation?.name ?? profile.id;

export const versionOf = (profile: ProfileSummary): number =>
  profile.workspace?.version ?? profile.installation?.version ?? 1;

/** The id a save of a new version under `name` would get. */
export function nextVersionId(
  workspace: { readonly id: string; readonly slug: string } | null | undefined,
  profiles: readonly ProfileSummary[],
  name: string,
): string {
  return workspaceProfileId(
    workspace ?? { id: "", slug: "" },
    name,
    Math.max(
      0,
      ...profiles
        .filter((item) => item.workspace?.name === name)
        .map((item) => item.workspace?.version ?? 0),
    ) + 1,
  );
}

/**
 * The versions of one line, newest first; each group's head is its latest.
 * A workspace profile's line is its name. A ceiling's is its `previous_id`
 * chain, which may change name (a catalog import's next version takes one)
 * while another ceiling may share a name without being linked.
 */
function groupsOf(items: readonly ProfileSummary[]): ProfileSummary[][] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const line = (item: ProfileSummary): { key: string; rank: number } => {
    if (item.source !== "operator")
      return { key: `workspace:${profileName(item)}`, rank: versionOf(item) };
    let at = item;
    let rank = 0;
    for (
      let prev = byId.get(at.installation?.previous_id ?? "");
      prev && rank < items.length;
      prev = byId.get(at.installation?.previous_id ?? "")
    ) {
      at = prev;
      rank += 1;
    }
    return { key: `operator:${at.id}`, rank };
  };
  const groups = new Map<string, { rank: number; item: ProfileSummary }[]>();
  for (const item of items) {
    const { key, rank } = line(item);
    const group = groups.get(key);
    if (group) group.push({ rank, item });
    else groups.set(key, [{ rank, item }]);
  }
  return [...groups.values()]
    .map((group) =>
      group.sort((a, b) => b.rank - a.rank).map(({ item }) => item),
    )
    .sort(([a], [b]) =>
      a && b
        ? // Ceilings first, as a workspace profile narrows one of them.
          (a.source === b.source ? 0 : a.source === "operator" ? -1 : 1) ||
          profileName(a).localeCompare(profileName(b)) ||
          a.id.localeCompare(b.id)
        : 0,
    );
}

export function ProfilesScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const profiles = useQuery(profilesQuery(client));
  const manages = useHasPermission("workspace.manage");
  const operates = useHasPermission("profile.installation.manage");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const items = profiles.data?.items ?? [];
  const ceilings = items.filter((item) => item.source === "operator");
  const versions = items.filter((item) => item.source === "workspace");
  const shown =
    filter === "installation"
      ? ceilings
      : filter === "workspace"
        ? versions
        : items;
  const groups = groupsOf(shown);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const stranded = versions.filter(
    (item) =>
      (item.workspace?.state === "base_changed" ||
        item.workspace?.state === "base_missing") &&
      !versions.some(
        (other) =>
          other.workspace?.name === item.workspace?.name &&
          versionOf(other) > versionOf(item),
      ),
  );

  return (
    <Page
      title={t("profiles.title")}
      description={t("profiles.description")}
      actions={
        manages || operates ? (
          <div className="flex flex-wrap gap-2">
            {operates ? (
              <Link
                className={buttonVariants({ variant: "outline" })}
                to="/profiles/new"
                search={{ kind: "installation" }}
              >
                <Plus aria-hidden="true" />
                {t("profiles.createCeiling")}
              </Link>
            ) : null}
            {manages && ceilings.some(pickable) ? (
              <Link
                className={buttonVariants()}
                to="/profiles/new"
                search={{ kind: "workspace" }}
              >
                <Plus aria-hidden="true" />
                {t("profiles.create")}
              </Link>
            ) : null}
          </div>
        ) : null
      }
    >
      {profiles.isPending ? (
        <Skeleton width="60%" />
      ) : profiles.isError ? (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-[var(--ap-space-block)]">
          {stranded.map((item) => (
            <Alert key={item.id} variant="red">
              <AlertTitle>
                {t(
                  item.workspace?.state === "base_missing"
                    ? "profiles.baseMissing.title"
                    : "profiles.baseChanged.title",
                  { name: profileName(item) },
                )}
              </AlertTitle>
              <AlertDescription>
                {t(
                  item.workspace?.state === "base_missing"
                    ? "profiles.baseMissing.text"
                    : "profiles.baseChanged.text",
                  {
                    name: profileName(item),
                    base: item.workspace?.base_profile_id ?? "",
                    id: item.id,
                  },
                )}
              </AlertDescription>
            </Alert>
          ))}
          {manages ? null : (
            <p className={cn("m-0 flex items-center gap-1", META)}>
              <Lock aria-hidden="true" className="size-3.5 shrink-0" />
              {t("profiles.locked")}
            </p>
          )}
          <SegmentedControl
            aria-label={t("profiles.filter.label")}
            size="toolbar"
            value={filter}
            onValueChange={(next) => setFilter(next as Filter)}
          >
            <SegmentedControlItem value="all" count={items.length}>
              {t("profiles.filter.all")}
            </SegmentedControlItem>
            <SegmentedControlItem value="installation" count={ceilings.length}>
              {t("profiles.kind.installation")}
            </SegmentedControlItem>
            <SegmentedControlItem value="workspace" count={versions.length}>
              {t("profiles.kind.workspace")}
            </SegmentedControlItem>
          </SegmentedControl>
          {groups.length === 0 ? (
            <EmptyState
              title={t(
                filter === "workspace"
                  ? "profiles.emptyWorkspace.title"
                  : "profiles.empty",
              )}
              description={
                filter === "workspace"
                  ? t("profiles.emptyWorkspace.text")
                  : undefined
              }
            />
          ) : (
            <div className="rounded-card border bg-card">
              <GridTable
                aria-label={t("profiles.title")}
                columns={COLUMNS[0]}
                narrowAt={860}
                narrowColumns={COLUMNS[1]}
              >
                <GridTableHeader>
                  <GridTableColumnHeader>
                    {t("profiles.column.name")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader hideNarrow>
                    {t("profiles.column.version")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader hideNarrow>
                    {t("profiles.column.kind")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader hideNarrow>
                    {t("profiles.column.base")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader hideNarrow>
                    {t("profiles.column.model")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader hideNarrow>
                    {t("profiles.editor.permissionMode")}
                  </GridTableColumnHeader>
                  <GridTableColumnHeader>
                    {t("profiles.column.state")}
                  </GridTableColumnHeader>
                </GridTableHeader>
                {groups.flatMap(([latest, ...older]) => {
                  if (latest === undefined) return [];
                  const open = expanded.has(latest.id);
                  return [latest, ...(open ? older : [])].map((item) => (
                    <ProfileRow
                      key={item.id}
                      profile={item}
                      older={
                        item === latest && older.length > 0
                          ? {
                              count: older.length,
                              expanded: open,
                              onToggle: () => toggle(latest.id),
                            }
                          : undefined
                      }
                    />
                  ));
                })}
              </GridTable>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}

function ProfileRow({
  profile,
  older,
}: {
  readonly profile: ProfileSummary;
  /** On the latest version of a name that has earlier ones. */
  readonly older:
    | {
        readonly count: number;
        readonly expanded: boolean;
        readonly onToggle: () => void;
      }
    | undefined;
}) {
  const { t } = useI18n();
  const state = stateOf(profile);
  const kind = profile.source === "operator" ? "installation" : "workspace";
  const Chevron = older?.expanded ? ChevronDown : ChevronRight;
  return (
    <GridTableRow>
      <GridTableCell>
        <GridTableRowOpener
          asChild
          aria-label={t("profiles.open", { name: profile.id })}
        >
          <Link to="/profiles/$profileId" params={{ profileId: profile.id }} />
        </GridTableRowOpener>
        <Stack
          first={
            <>
              <span className="font-medium text-foreground">
                {profileName(profile)}
              </span>
              {older ? (
                <>
                  {" "}
                  <button
                    type="button"
                    aria-expanded={older.expanded}
                    onClick={older.onToggle}
                    // Inline, so a narrow column wraps it between words like
                    // the name beside it instead of pushing into the next column.
                    // Positioned above the row opener, which covers the row.
                    className={cn(
                      "relative z-1 inline break-keep rounded-control text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
                      META,
                    )}
                  >
                    <Chevron
                      aria-hidden="true"
                      className="mr-0.5 inline size-3.5 align-[-2px]"
                    />
                    {t("profiles.olderVersions", { count: older.count })}
                  </button>
                </>
              ) : null}
            </>
          }
          second={profile.id}
          secondClassName="font-mono"
          narrow={t("profiles.narrowKind", {
            kind: t(`profiles.kind.${kind}`),
            version: versionOf(profile),
          })}
        />
      </GridTableCell>
      <GridTableCell hideNarrow>
        <span className={META}>
          {t("profiles.versionTag", { version: versionOf(profile) })}
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <span className={META}>{t(`profiles.kind.${kind}`)}</span>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <span className="font-mono text-caption wrap-anywhere">
          {profile.workspace?.base_profile_id ?? "—"}
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <span className="font-mono text-caption wrap-anywhere">
          {profile.model}
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow>
        <span className="font-mono text-caption">
          {profile.permission_mode}
        </span>
      </GridTableCell>
      <GridTableCell>
        <Badge variant={STATE_BADGE[state]}>
          {t(`profiles.state.${state}`)}
        </Badge>
      </GridTableCell>
    </GridTableRow>
  );
}

// Not GridTableCell `lines`, which truncates: on a phone every value wraps
// in full instead.
function Stack({
  first,
  second,
  secondClassName,
  narrow,
}: {
  readonly first: ReactNode;
  readonly second: string;
  readonly secondClassName?: string;
  /** A third line only a phone shows, for the columns it hides. */
  readonly narrow: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
      <span className="wrap-anywhere leading-5">{first}</span>
      <span className={cn("wrap-anywhere leading-4", META, secondClassName)}>
        {second}
      </span>
      {/* GridTable's narrowAt={860} breakpoint, the width the columns drop at. */}
      <span
        className={cn(
          "hidden wrap-anywhere leading-4 [@container(max-width:860px)]:block",
          META,
        )}
      >
        {narrow}
      </span>
    </div>
  );
}
