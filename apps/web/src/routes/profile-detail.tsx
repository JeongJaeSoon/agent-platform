import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { ProfileSummary } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  buttonVariants,
  cn,
  EmptyState,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  KeyValueList,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  Section,
  Skeleton,
} from "@werft-ai/ui";
import { Lock } from "lucide-react";
import { useState } from "react";
import { agentsQuery, profilesQuery } from "../api/queries.ts";
import { useHasPermission, useMe } from "../auth/guard.tsx";
import { Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { type EditorStart, ProfileEditor } from "./profile-editor.tsx";
import { nextVersionId, STATE_BADGE } from "./profiles.tsx";

const META = "text-caption text-muted-foreground";
const HISTORY_COLUMNS = [
  "minmax(0,1fr) 128px 168px",
  "minmax(0,1fr) 104px",
] as const;
const AGENT_COLUMNS = "minmax(0,1fr) minmax(0,1fr)";

export function ProfileDetailScreen() {
  const { t } = useI18n();
  const { profileId } = useParams({ from: "/authed/profiles/$profileId" });
  const { client } = useAgentPlatform();
  const navigate = useNavigate();
  const workspace = useMe()?.workspace;
  const manages = useHasPermission("workspace.manage");
  const profiles = useQuery(profilesQuery(client));
  // Both kept per profile id: the screen stays mounted when another
  // version's link changes the param, and neither belongs to that version.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    readonly on: string;
    readonly text: string;
  } | null>(null);

  const items = profiles.data?.items ?? [];
  const profile = items.find((item) => item.id === profileId);
  const operators = items.filter((item) => item.source === "operator");
  const base = operators.find(
    (item) => item.id === profile?.workspace?.base_profile_id,
  );
  const state = profile?.workspace?.state;

  const breadcrumb = (
    <PageBreadcrumb label={t("shell.breadcrumb")}>
      <PageBreadcrumbLink asChild>
        <Link to="/profiles" activeOptions={{ exact: true }}>
          {t("profiles.title")}
        </Link>
      </PageBreadcrumbLink>
      <PageBreadcrumbCurrent>{profileId}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );

  if (profiles.isPending)
    return (
      <Page title={profileId} breadcrumb={breadcrumb}>
        <Skeleton width="60%" />
      </Page>
    );
  if (profiles.isError)
    return (
      <Page title={profileId} breadcrumb={breadcrumb}>
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      </Page>
    );
  if (profile === undefined)
    return (
      <Page
        title={t("profiles.detail.notFound.title")}
        description={t("profiles.detail.notFound.text", { id: profileId })}
        breadcrumb={breadcrumb}
      >
        <Link
          className={buttonVariants({
            variant: "outline",
            className: "self-start",
          })}
          to="/profiles"
        >
          {t("profiles.detail.back")}
        </Link>
      </Page>
    );

  // A workspace profile takes a new version; an operator profile is the base
  // of a new one.
  const start: EditorStart | null = !manages
    ? null
    : profile.source === "operator"
      ? { mode: "new", base: profile }
      : base !== undefined && (state === "usable" || state === "base_changed")
        ? {
            mode: state === "usable" ? "version" : "remake",
            from: profile,
            base,
          }
        : null;
  const startLabel =
    start?.mode === "new"
      ? "profiles.detail.createFrom"
      : start?.mode === "remake"
        ? "profiles.remake"
        : "profiles.newVersion";
  const editor = editingId === profile.id ? start : null;

  return (
    <Page
      breadcrumb={breadcrumb}
      title={
        <span className="[overflow-wrap:anywhere]">
          {profile.workspace?.name ?? profile.id}
        </span>
      }
      titleAside={
        profile.workspace ? (
          <span className="flex items-center gap-2">
            <span className={META}>
              {t("profiles.versionTag", { version: profile.workspace.version })}
            </span>
            <Badge variant={STATE_BADGE[profile.workspace.state]}>
              {t(`profiles.state.${profile.workspace.state}`)}
            </Badge>
          </span>
        ) : null
      }
      description={t(
        profile.workspace
          ? "profiles.detail.workspaceDescription"
          : "profiles.operator.description",
      )}
      actions={
        start !== null && editor === null ? (
          <Button
            type="button"
            onClick={() => {
              setNotice(null);
              setEditingId(profile.id);
            }}
          >
            {t(startLabel)}
          </Button>
        ) : null
      }
    >
      <Notice>{notice?.on === profile.id ? notice.text : undefined}</Notice>
      {editor === null ? null : (
        <ProfileEditor
          key={profile.id}
          start={editor}
          operators={operators}
          nextId={(name) => nextVersionId(workspace, items, name)}
          onCancel={() => setEditingId(null)}
          onSaved={(id) => {
            setEditingId(null);
            setNotice({ on: id, text: t("profiles.saved", { id }) });
            void navigate({
              to: "/profiles/$profileId",
              params: { profileId: id },
            });
          }}
        />
      )}
      <Section title={t("profiles.detail.settings")}>
        {manages || !profile.workspace ? null : (
          <p className={cn("m-0 mb-3 flex items-center gap-1", META)}>
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            {t("profiles.locked")}
          </p>
        )}
        <Settings profile={profile} />
      </Section>
      {profile.workspace ? (
        <History profile={profile} versions={items} />
      ) : null}
      <AgentsOn profile={profile} />
    </Page>
  );
}

function Settings({ profile }: { readonly profile: ProfileSummary }) {
  const { t, locale } = useI18n();
  const list = (values: readonly string[]) =>
    values.length === 0 ? (
      t("profiles.noTools")
    ) : (
      <span className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} variant="mono">
            {value}
          </Badge>
        ))}
      </span>
    );
  const made = profile.workspace;
  return (
    <div className="rounded-card border bg-card p-4">
      <KeyValueList
        items={[
          {
            id: "id",
            label: t("profiles.detail.id"),
            value: (
              <span className="font-mono [overflow-wrap:anywhere]">
                {profile.id}
              </span>
            ),
          },
          ...(made
            ? [
                {
                  id: "base",
                  label: t("profiles.editor.base"),
                  value: (
                    <Link
                      className="font-mono underline-offset-4 hover:underline [overflow-wrap:anywhere]"
                      to="/profiles/$profileId"
                      params={{ profileId: made.base_profile_id }}
                    >
                      {made.base_profile_id}
                    </Link>
                  ),
                },
              ]
            : []),
          {
            id: "model",
            label: t("profiles.editor.defaultModel"),
            value: <span className="font-mono">{profile.model}</span>,
          },
          {
            id: "models",
            label: t("profiles.detail.models"),
            value: list(profile.models),
          },
          {
            id: "tools",
            label: t("profiles.editor.tools"),
            value: list(profile.tools),
          },
          {
            id: "mode",
            label: t("profiles.editor.permissionMode"),
            value: <span className="font-mono">{profile.permission_mode}</span>,
          },
          {
            id: "environment",
            label: t("profiles.column.environment"),
            value: [
              t("profiles.runtime", { version: profile.runtime_version }),
              t(`profiles.repository.${profile.repository_mode}`),
              t(`profiles.billing.${profile.billing}`),
            ].join(" · "),
          },
          ...(made
            ? [
                {
                  id: "created",
                  label: t("profiles.detail.created"),
                  value: formatTimestamp(made.created_at, locale),
                },
              ]
            : []),
          ...(made?.retired_at
            ? [
                {
                  id: "retired",
                  label: t("profiles.detail.retiredAt"),
                  value: formatTimestamp(made.retired_at, locale),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

function History({
  profile,
  versions,
}: {
  readonly profile: ProfileSummary;
  readonly versions: readonly ProfileSummary[];
}) {
  const { t, locale } = useI18n();
  const name = profile.workspace?.name;
  const rows = versions
    .filter(
      (item) => item.source === "workspace" && item.workspace?.name === name,
    )
    .sort((a, b) => (b.workspace?.version ?? 0) - (a.workspace?.version ?? 0));
  return (
    <Section
      title={t("profiles.detail.history.title")}
      description={t("profiles.workspace.description")}
    >
      <div className="rounded-card border bg-card">
        <GridTable
          aria-label={t("profiles.detail.history.title")}
          columns={HISTORY_COLUMNS[0]}
          narrowAt={640}
          narrowColumns={HISTORY_COLUMNS[1]}
        >
          <GridTableHeader>
            <GridTableColumnHeader>
              {t("profiles.detail.history.version")}
            </GridTableColumnHeader>
            <GridTableColumnHeader>
              {t("profiles.column.state")}
            </GridTableColumnHeader>
            <GridTableColumnHeader hideNarrow>
              {t("profiles.detail.created")}
            </GridTableColumnHeader>
          </GridTableHeader>
          {rows.map((item) => {
            const made = item.workspace;
            if (made === undefined) return null;
            const current = item.id === profile.id;
            return (
              <GridTableRow key={item.id}>
                <GridTableCell>
                  <GridTableRowOpener
                    asChild
                    aria-label={t("profiles.open", { name: item.id })}
                  >
                    <Link
                      to="/profiles/$profileId"
                      params={{ profileId: item.id }}
                    />
                  </GridTableRowOpener>
                  <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
                    <span className="leading-5">
                      <span className="font-medium text-foreground">
                        {t("profiles.versionTag", { version: made.version })}
                      </span>
                      {current ? (
                        <span className={META}>
                          {" "}
                          {t("profiles.detail.history.current")}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn("font-mono leading-4 wrap-anywhere", META)}
                    >
                      {item.id}
                    </span>
                  </div>
                </GridTableCell>
                <GridTableCell>
                  <Badge variant={STATE_BADGE[made.state]}>
                    {t(`profiles.state.${made.state}`)}
                  </Badge>
                </GridTableCell>
                <GridTableCell hideNarrow>
                  <span className={META}>
                    {formatTimestamp(made.created_at, locale)}
                  </span>
                </GridTableCell>
              </GridTableRow>
            );
          })}
        </GridTable>
      </div>
    </Section>
  );
}

/** Agents whose active release names this profile. */
function AgentsOn({ profile }: { readonly profile: ProfileSummary }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  // The server refuses the list to anyone else; they ask for none.
  const lists = useHasPermission("agent.manage");
  const agents = useQuery({ ...agentsQuery(client), enabled: lists });
  const using = (agents.data?.items ?? []).filter(
    (agent) =>
      agent.active_release_id !== null &&
      agent.summary?.runtime_profile_id === profile.id,
  );
  return (
    <Section
      title={t("profiles.detail.agents.title")}
      badge={
        agents.data && using.length > 0 ? (
          <Badge variant="gray">
            {t("profiles.count", { count: using.length })}
          </Badge>
        ) : null
      }
      description={t("profiles.detail.agents.description")}
    >
      {!lists ? (
        <p className={cn("m-0 flex items-center gap-1", META)}>
          <Lock aria-hidden="true" className="size-3.5 shrink-0" />
          {t("profiles.detail.agents.withheld")}
        </p>
      ) : agents.isPending ? (
        <Skeleton width="40%" />
      ) : agents.isError ? (
        <LoadFailure
          error={agents.error}
          onRetry={() => void agents.refetch()}
        />
      ) : using.length === 0 ? (
        <EmptyState title={t("profiles.detail.agents.empty")} />
      ) : (
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label={t("profiles.detail.agents.title")}
            columns={AGENT_COLUMNS}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("profiles.detail.agents.agent")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("profiles.detail.agents.release")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {using.map((agent) => (
              <GridTableRow key={agent.id}>
                <GridTableCell>
                  <GridTableRowOpener
                    asChild
                    aria-label={t("profiles.detail.agents.open", {
                      name: agent.name,
                    })}
                  >
                    <Link
                      to="/agents/$id"
                      params={{ id: agent.id }}
                      search={{ tab: "release" }}
                    />
                  </GridTableRowOpener>
                  <span className="font-medium text-foreground [overflow-wrap:anywhere]">
                    {agent.name}
                  </span>
                </GridTableCell>
                <GridTableCell>
                  {/* As the release tab names it: by the agent version. */}
                  <span className={META}>
                    {t("profiles.detail.agents.releaseVersion", {
                      version: agent.summary?.version.version_no ?? "?",
                    })}
                  </span>
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </div>
      )}
    </Section>
  );
}
