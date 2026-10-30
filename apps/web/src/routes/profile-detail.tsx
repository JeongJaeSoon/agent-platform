import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  ProfileSummary,
  WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  buttonVariants,
  ConfirmDialog,
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
import { type ReactNode, useState } from "react";
import { agentsQuery, profilesQuery, queryKeysOf } from "../api/queries.ts";
import {
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { pickable } from "../components/profile-options.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { profileName, STATE_BADGE, stateOf, versionOf } from "./profiles.tsx";

const META = "text-caption text-muted-foreground";
const HISTORY_COLUMNS = [
  "minmax(0,1fr) 152px 168px",
  "minmax(0,1fr) 128px",
] as const;
const AGENT_COLUMNS = "minmax(0,1fr) minmax(0,1fr)";

/**
 * The versions of `profile`'s line: a workspace profile's name, or for a
 * ceiling every row the `previous_id` links reach, either way.
 */
function lineOf(
  profile: ProfileSummary,
  items: readonly ProfileSummary[],
): ProfileSummary[] {
  if (profile.workspace) {
    return items.filter(
      (item) => item.workspace?.name === profile.workspace?.name,
    );
  }
  const ceilings = items.filter((item) => item.source === "operator");
  const line = new Set([profile.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const item of ceilings) {
      const previous = item.installation?.previous_id;
      if (line.has(item.id) && previous && !line.has(previous)) {
        line.add(previous);
        grew = true;
      } else if (previous && line.has(previous) && !line.has(item.id)) {
        line.add(item.id);
        grew = true;
      }
    }
  }
  return ceilings.filter((item) => line.has(item.id));
}

export function ProfileDetailScreen() {
  const { t } = useI18n();
  const { profileId } = useParams({ from: "/authed/profiles/$profileId" });
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const manages = useHasPermission("workspace.manage");
  const operates = useHasPermission("profile.installation.manage");
  const profiles = useQuery(profilesQuery(client));
  // Kept per profile id: the screen stays mounted when another version's
  // link changes the param.
  const [retiring, setRetiring] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    readonly on: string;
    readonly text: string;
  } | null>(null);

  const items = profiles.data?.items ?? [];
  const profile = items.find((item) => item.id === profileId);
  const ceiling = profile?.source === "operator";
  // Workspace versions answer to an owner or admin, ceilings to an owner.
  const changes = ceiling ? operates : manages;

  const retire = useMutation<WorkspaceProfileChangeResponse, ApiError, string>({
    mutationFn: (id) =>
      unwrap(
        ceiling
          ? client.POST("/v1/installation-profiles/{profile_id}/retire", {
              params: { path: { profile_id: id } },
            })
          : client.POST("/v1/workspace-profiles/{profile_id}/retire", {
              params: { path: { profile_id: id } },
            }),
      ),
    onMutate: () => setRetireError(null),
    onSuccess: async ({ profile: retired }) => {
      setRetiring(null);
      setNotice({
        on: retired.id,
        text: t("profiles.retired", { id: retired.id }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
    },
    onError: (failure) =>
      setRetireError(
        ceiling && failure.code === "FORBIDDEN"
          ? t("profiles.ceiling.ownerOnly")
          : refusalText(t, failure, "workspace.manage", role),
      ),
  });

  // Which way the dialog goes is fixed when it opens, so a list refresh
  // underneath cannot turn a block into an unblock.
  const [blocking, setBlocking] = useState<{
    readonly id: string;
    readonly block: boolean;
  } | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);
  const block = useMutation<
    WorkspaceProfileChangeResponse,
    ApiError,
    { readonly id: string; readonly block: boolean }
  >({
    mutationFn: ({ id, block }) =>
      unwrap(
        block
          ? client.POST("/v1/installation-profiles/{profile_id}/block", {
              params: { path: { profile_id: id } },
            })
          : client.POST("/v1/installation-profiles/{profile_id}/unblock", {
              params: { path: { profile_id: id } },
            }),
      ),
    onMutate: () => setBlockError(null),
    onSuccess: async ({ profile: changed }, { block }) => {
      setBlocking(null);
      setNotice({
        on: changed.id,
        text: t(block ? "profiles.blockDone" : "profiles.unblockDone", {
          id: changed.id,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
    },
    onError: (failure) =>
      setBlockError(
        failure.code === "FORBIDDEN"
          ? t("profiles.blockOwnerOnly")
          : refusalText(t, failure, "workspace.manage", role),
      ),
  });

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

  const state = stateOf(profile);
  const base = items.find(
    (item) =>
      item.id === profile.workspace?.base_profile_id &&
      item.source === "operator",
  );
  const actions: ReactNode[] = [];
  if (ceiling) {
    if (manages && pickable(profile))
      actions.push(
        <Link
          key="narrow"
          className={buttonVariants({ variant: "outline" })}
          to="/profiles/new"
          search={{ kind: "workspace", from: profile.id }}
        >
          {t("profiles.detail.createFrom")}
        </Link>,
      );
    // The server takes a new version of a name only from its latest; an
    // imported ceiling has no name, so any new name may follow it.
    const name = profile.installation?.name;
    if (
      operates &&
      !(
        name &&
        items.some(
          (item) =>
            item.installation?.name === name &&
            versionOf(item) > versionOf(profile),
        )
      )
    )
      actions.push(
        <Link
          key="version"
          className={buttonVariants()}
          to="/profiles/new"
          search={{ kind: "installation", from: profile.id, mode: "version" }}
        >
          {t("profiles.newVersion")}
        </Link>,
      );
  } else if (
    manages &&
    base !== undefined &&
    pickable(base) &&
    (state === "usable" || state === "base_changed")
  ) {
    actions.push(
      <Link
        key="version"
        className={buttonVariants()}
        to="/profiles/new"
        search={{
          kind: "workspace",
          from: profile.id,
          mode: state === "usable" ? "version" : "remake",
        }}
      >
        {t(state === "usable" ? "profiles.newVersion" : "profiles.remake")}
      </Link>,
    );
  }
  if (changes && state !== "retired")
    actions.push(
      <Button
        key="retire"
        type="button"
        variant="outline"
        onClick={() => {
          setRetireError(null);
          setRetiring(profile.id);
        }}
      >
        {t("profiles.retire")}
      </Button>,
    );
  // Only the owner blocks a ceiling; a retired one can be blocked too.
  if (ceiling && operates) {
    const blocked = state === "blocked";
    actions.push(
      <Button
        key="block"
        type="button"
        variant="outline"
        onClick={() => {
          setBlockError(null);
          setBlocking({ id: profile.id, block: !blocked });
        }}
      >
        {t(blocked ? "profiles.unblock" : "profiles.block")}
      </Button>,
    );
  }

  // Losing the role closes the dialog; a request already sent still reports here.
  const retireOpen = retiring === profile.id && changes;
  const blockOpen = blocking?.id === profile.id && ceiling && operates;
  const blockAction = blocking?.block ?? true;

  return (
    <Page
      breadcrumb={breadcrumb}
      title={
        <span className="[overflow-wrap:anywhere]">{profileName(profile)}</span>
      }
      titleAside={
        <span className="flex items-center gap-2">
          <span className={META}>
            {t("profiles.versionTag", { version: versionOf(profile) })}
          </span>
          <Badge variant={STATE_BADGE[state]}>
            {t(`profiles.state.${state}`)}
          </Badge>
        </span>
      }
      description={t(
        ceiling
          ? "profiles.detail.ceilingDescription"
          : "profiles.detail.workspaceDescription",
      )}
      actions={
        actions.length === 0 ? null : (
          <div className="flex flex-wrap gap-2">{actions}</div>
        )
      }
    >
      <Notice>{notice?.on === profile.id ? notice.text : undefined}</Notice>
      {retireError === null || retireOpen ? null : (
        <Alert variant="red" role="alert">
          <AlertDescription>{retireError}</AlertDescription>
        </Alert>
      )}
      {blockError === null || blockOpen ? null : (
        <Alert variant="red" role="alert">
          <AlertDescription>{blockError}</AlertDescription>
        </Alert>
      )}
      {state === "usable" ? null : (
        <Alert variant={STATE_BADGE[state] === "red" ? "red" : "blue"}>
          <AlertDescription>
            {t(`profiles.stateReason.${state}`, {
              base: profile.workspace?.base_profile_id ?? "",
            })}
          </AlertDescription>
        </Alert>
      )}
      <Section title={t("profiles.detail.settings")}>
        {changes ? null : (
          <p className={cn("m-0 mb-3 flex items-center gap-1", META)}>
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            {t(ceiling ? "profiles.detail.ownerOnly" : "profiles.locked")}
          </p>
        )}
        <Settings profile={profile} />
      </Section>
      <Section title={t("profiles.detail.audit.title")}>
        <Audit profile={profile} />
      </Section>
      <History profile={profile} versions={lineOf(profile, items)} />
      {ceiling ? <Narrowings ceiling={profile} items={items} /> : null}
      <AgentsOn profile={profile} />
      <ConfirmDialog
        open={retireOpen}
        onOpenChange={(next) => {
          if (!next && !retire.isPending) {
            setRetiring(null);
            setRetireError(null);
          }
        }}
        title={t("profiles.retireTitle", { id: profile.id })}
        consequence={t(
          ceiling ? "profiles.retireCeilingText" : "profiles.retireText",
        )}
        confirmLabel={
          retire.isPending ? t("profiles.retiring") : t("profiles.retire")
        }
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={retire.isPending}
        onConfirm={() => {
          if (retireOpen && !retire.isPending) retire.mutate(profile.id);
        }}
      >
        {retireError === null ? null : (
          <Alert variant="red" role="alert">
            <AlertDescription>{retireError}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={blockOpen}
        onOpenChange={(next) => {
          if (!next && !block.isPending) {
            setBlocking(null);
            setBlockError(null);
          }
        }}
        title={t(
          blockAction ? "profiles.blockTitle" : "profiles.unblockTitle",
          {
            id: profile.id,
          },
        )}
        consequence={t(
          blockAction ? "profiles.blockText" : "profiles.unblockText",
        )}
        confirmLabel={
          block.isPending
            ? t(blockAction ? "profiles.blocking" : "profiles.unblocking")
            : t(blockAction ? "profiles.block" : "profiles.unblock")
        }
        cancelLabel={t("common.cancel")}
        tone={blockAction ? "danger" : "default"}
        busy={block.isPending}
        onConfirm={() => {
          if (blockOpen && !block.isPending)
            block.mutate({ id: profile.id, block: blockAction });
        }}
      >
        {blockError === null ? null : (
          <Alert variant="red" role="alert">
            <AlertDescription>{blockError}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
    </Page>
  );
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono [overflow-wrap:anywhere]">{children}</span>;
}

function ProfileLink({ id }: { readonly id: string }) {
  return (
    <Link
      className="font-mono underline-offset-4 hover:underline [overflow-wrap:anywhere]"
      to="/profiles/$profileId"
      params={{ profileId: id }}
    >
      {id}
    </Link>
  );
}

function Settings({ profile }: { readonly profile: ProfileSummary }) {
  const { t } = useI18n();
  const list = (values: readonly string[], none: string) =>
    values.length === 0 ? (
      none
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
  const ceiling = profile.installation;
  const item = (id: string, label: string, value: ReactNode) => ({
    id,
    label,
    value,
  });
  return (
    <div className="rounded-card border bg-card p-4">
      <KeyValueList
        items={[
          item("id", t("profiles.detail.id"), <Mono>{profile.id}</Mono>),
          item(
            "kind",
            t("profiles.column.kind"),
            t(`profiles.kind.${made ? "workspace" : "installation"}`),
          ),
          ...(made
            ? [
                item(
                  "base",
                  t("profiles.editor.base"),
                  <ProfileLink id={made.base_profile_id} />,
                ),
              ]
            : []),
          ...(ceiling
            ? [
                item(
                  "connection",
                  t("profiles.ceiling.connection"),
                  ceiling.connection_id === null ? (
                    t("profiles.state.connection_missing")
                  ) : (
                    <Mono>{ceiling.connection_id}</Mono>
                  ),
                ),
              ]
            : []),
          item(
            "runtime",
            t("profiles.ceiling.runtime"),
            <Mono>{`${profile.runtime_kind} ${profile.runtime_version}`}</Mono>,
          ),
          item(
            "model",
            t("profiles.editor.defaultModel"),
            <Mono>{profile.model}</Mono>,
          ),
          item(
            "models",
            t("profiles.detail.models"),
            list(profile.models, t("profiles.noTools")),
          ),
          ...(ceiling
            ? [
                item(
                  "title-model",
                  t("profiles.ceiling.titleModel"),
                  ceiling.title_model === null ? (
                    t("profiles.detail.titleModelDefault")
                  ) : (
                    <Mono>{ceiling.title_model}</Mono>
                  ),
                ),
              ]
            : []),
          item(
            "tools",
            t("profiles.editor.tools"),
            list(profile.tools, t("profiles.noTools")),
          ),
          item(
            "mode",
            t("profiles.editor.permissionMode"),
            <Mono>{profile.permission_mode}</Mono>,
          ),
          item(
            "repository-mode",
            t("profiles.ceiling.repositoryMode"),
            t(`profiles.repository.${profile.repository_mode}`),
          ),
          ...(profile.repository_ids === undefined
            ? []
            : [
                item(
                  "repositories",
                  t("profiles.ceiling.repositories"),
                  list(
                    profile.repository_ids,
                    t("profiles.detail.noRepositories"),
                  ),
                ),
              ]),
          item(
            "billing",
            t("profiles.detail.billing"),
            t(`profiles.billing.${profile.billing}`),
          ),
          ...(ceiling
            ? [
                item(
                  "claude-md",
                  t("profiles.ceiling.claudeMd"),
                  t(
                    ceiling.project_settings.claude_md
                      ? "profiles.on"
                      : "profiles.off",
                  ),
                ),
              ]
            : []),
        ]}
      />
    </div>
  );
}

function Audit({ profile }: { readonly profile: ProfileSummary }) {
  const { t, locale } = useI18n();
  const me = useMe()?.user?.id;
  const record = profile.installation ?? profile.workspace;
  const imported = profile.installation?.origin === "catalog";
  const who = (id: string | null | undefined) =>
    id === null || id === undefined ? (
      t(
        imported
          ? "profiles.detail.audit.imported"
          : "profiles.detail.audit.unknown",
      )
    ) : (
      <Mono>{id === me ? t("profiles.detail.audit.you", { id }) : id}</Mono>
    );
  if (record === undefined) return null;
  const previous = profile.installation?.previous_id;
  return (
    <div className="rounded-card border bg-card p-4">
      <KeyValueList
        items={[
          ...(profile.installation
            ? [
                {
                  id: "origin",
                  label: t("profiles.detail.audit.origin"),
                  value: t(`profiles.origin.${profile.installation.origin}`),
                },
              ]
            : []),
          {
            id: "created-by",
            label: t("profiles.detail.audit.createdBy"),
            value: who(record.created_by),
          },
          {
            id: "created-at",
            label: t("profiles.detail.created"),
            value: formatTimestamp(record.created_at, locale),
          },
          ...(profile.installation
            ? [
                {
                  id: "previous",
                  label: t("profiles.detail.audit.previous"),
                  value: previous ? (
                    <ProfileLink id={previous} />
                  ) : (
                    t("profiles.detail.audit.noPrevious")
                  ),
                },
              ]
            : []),
          ...(record.retired_at
            ? [
                {
                  id: "retired-by",
                  label: t("profiles.detail.audit.retiredBy"),
                  value: who(record.retired_by),
                },
                {
                  id: "retired-at",
                  label: t("profiles.detail.retiredAt"),
                  value: formatTimestamp(record.retired_at, locale),
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
  const rows = [...versions].sort(
    (a, b) =>
      (
        b.installation?.created_at ??
        b.workspace?.created_at ??
        ""
      ).localeCompare(
        a.installation?.created_at ?? a.workspace?.created_at ?? "",
      ) || versionOf(b) - versionOf(a),
  );
  return (
    <Section
      title={t("profiles.detail.history.title")}
      description={t(
        profile.installation
          ? "profiles.detail.history.ceilingDescription"
          : "profiles.workspace.description",
      )}
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
            const state = stateOf(item);
            const created =
              item.installation?.created_at ?? item.workspace?.created_at;
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
                        {item.workspace
                          ? t("profiles.versionTag", {
                              version: versionOf(item),
                            })
                          : t("profiles.detail.history.named", {
                              name: profileName(item),
                              version: versionOf(item),
                            })}
                      </span>
                      {item.id === profile.id ? (
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
                  <Badge variant={STATE_BADGE[state]}>
                    {t(`profiles.state.${state}`)}
                  </Badge>
                </GridTableCell>
                <GridTableCell hideNarrow>
                  <span className={META}>
                    {created ? formatTimestamp(created, locale) : "—"}
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

/** The workspace profiles made on a ceiling. */
function Narrowings({
  ceiling,
  items,
}: {
  readonly ceiling: ProfileSummary;
  readonly items: readonly ProfileSummary[];
}) {
  const { t } = useI18n();
  const rows = items.filter(
    (item) => item.workspace?.base_profile_id === ceiling.id,
  );
  return (
    <Section
      title={t("profiles.detail.narrowings.title")}
      badge={
        rows.length === 0 ? null : (
          <Badge variant="gray">
            {t("profiles.count", { count: rows.length })}
          </Badge>
        )
      }
      description={t("profiles.detail.narrowings.description")}
    >
      {rows.length === 0 ? (
        <EmptyState title={t("profiles.detail.narrowings.empty")} />
      ) : (
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label={t("profiles.detail.narrowings.title")}
            columns={HISTORY_COLUMNS[0]}
            narrowAt={640}
            narrowColumns={HISTORY_COLUMNS[1]}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("profiles.column.name")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("profiles.column.state")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("profiles.column.model")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {rows.map((item) => {
              const state = stateOf(item);
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
                      <span className="font-medium text-foreground leading-5 wrap-anywhere">
                        {t("profiles.detail.history.named", {
                          name: profileName(item),
                          version: versionOf(item),
                        })}
                      </span>
                      <span
                        className={cn(
                          "font-mono leading-4 wrap-anywhere",
                          META,
                        )}
                      >
                        {item.id}
                      </span>
                    </div>
                  </GridTableCell>
                  <GridTableCell>
                    <Badge variant={STATE_BADGE[state]}>
                      {t(`profiles.state.${state}`)}
                    </Badge>
                  </GridTableCell>
                  <GridTableCell hideNarrow>
                    <span className="font-mono text-caption wrap-anywhere">
                      {item.model}
                    </span>
                  </GridTableCell>
                </GridTableRow>
              );
            })}
          </GridTable>
        </div>
      )}
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
                  {/* As the release tab names it. */}
                  <span className={`${META} tabular-nums`}>
                    {agent.summary?.release_label ?? "?"}
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
