import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  MemberView,
  TeamChangeResponse,
  TeamDetail,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Avatar,
  avatarInitials,
  avatarTone,
  Badge,
  Button,
  buttonVariants,
  Combobox,
  ConfirmDialog,
  EmptyState,
  Field,
  FieldLabel,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  RowList,
  RowListItem,
  SearchInput,
  SettingRow,
  Link as TextLink,
} from "@werft-ai/ui";
import { ArrowLeft, ChevronRight, X } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import {
  membersQuery,
  queryKeysOf,
  teamQuery,
  teamsQuery,
} from "../api/queries.ts";
import {
  refusalText,
  roleLabel,
  useHasPermission,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import {
  MUTED,
  MyTeams,
  SECTION,
  SECTION_TITLE,
} from "../components/my-teams.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { OPENS_ROW, ROW_LINK } from "../components/row-link.ts";
import { SEARCH_MAX } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { SettingsCard } from "./workspace-settings.tsx";
import { DangerZone } from "./workspace-slack.tsx";

// The name and its button share a row; the button drops under the field only
// when the row is too narrow for both.
const INLINE_FORM = "flex max-w-xl flex-wrap items-end gap-2";
const NAME_FIELD = "min-w-0 flex-[1_1_14rem]";
const SECONDARY = "text-muted-foreground text-sm [overflow-wrap:anywhere]";

type TeamMember = TeamDetail["members"][number];

function matches(member: TeamMember, needle: string): boolean {
  return [member.display_name, member.email].some(
    (text) => text?.normalize("NFKC").toLowerCase().includes(needle) ?? false,
  );
}
function ListError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  return isApiError(error, "FORBIDDEN") ? (
    <StatusScreen kind="forbidden" />
  ) : (
    <LoadFailure error={error} onRetry={onRetry} />
  );
}

function TeamNameField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field className={NAME_FIELD}>
      <FieldLabel>{t("teams.name")}</FieldLabel>
      <Input
        name="team-name"
        required
        maxLength={100}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** Teams: groups of people an owner or admin manages (design 4.7). */
export function TeamsScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const manages = useHasPermission("team.manage");
  const teams = useQuery({ ...teamsQuery(client), enabled: manages });
  const titleId = useId();

  if (!manages) {
    return (
      <TeamsTab>
        <MyTeams showEmpty />
      </TeamsTab>
    );
  }

  // Creating a team is the page head's button (TeamCreateDialog).
  return (
    <TeamsTab>
      <section className={SECTION} aria-labelledby={titleId}>
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("teams.listTitle")}
        </h2>
        {teams.isPending ? (
          <StatusScreen kind="loading" />
        ) : teams.error ? (
          <ListError error={teams.error} onRetry={() => void teams.refetch()} />
        ) : teams.data.items.length === 0 ? (
          <EmptyState title={t("teams.empty")} />
        ) : (
          <RowList>
            {teams.data.items.map((team) => (
              <RowListItem key={team.id} className={OPENS_ROW}>
                <TextLink
                  asChild
                  className={`${ROW_LINK} [overflow-wrap:anywhere]`}
                >
                  <Link
                    to="/members/teams/$teamId"
                    params={{ teamId: team.id }}
                  >
                    {team.name}
                  </Link>
                </TextLink>
                <span className={`${SECONDARY} ml-auto`}>
                  {t("teams.memberCount", { count: team.member_count })}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-subtle-foreground"
                />
              </RowListItem>
            ))}
          </RowList>
        )}
      </section>
      {isApiError(teams.error, "FORBIDDEN") ? <MyTeams showEmpty /> : null}
    </TeamsTab>
  );
}

/** The 팀 tab of 구성원: what teams are for, then the tab's own sections. */
function TeamsTab({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-[var(--ap-space-section)]">
      <p className={`${MUTED} m-0 text-sm`}>{t("teams.intro")}</p>
      {children}
    </div>
  );
}

export function TeamDetailScreen() {
  const { teamId } = useParams({ from: "/authed/members/teams/$teamId" });
  return <TeamPage key={teamId} id={teamId} />;
}

function TeamPage({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const team = useQuery(teamQuery(client, id));
  // A team's own members read it; only managers see what changes it.
  const manages = useHasPermission("team.manage");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const back = (
    <Link
      to="/members/teams"
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      {t("teams.back")}
    </Link>
  );

  if (team.isPending) return <StatusScreen kind="loading" />;
  // Inside the 팀 tab (v3 M-03): the page head stays 구성원, the team's name
  // heads the tab with the way back beside it.
  return (
    <div className="flex flex-col gap-[var(--ap-space-section)]">
      <div className="flex items-start justify-between gap-4">
        <h2 className="m-0 min-w-0 font-semibold text-body [overflow-wrap:anywhere]">
          {team.error ? t("teams.title") : team.data.name}
        </h2>
        {back}
      </div>
      {team.error ? (
        <ListError error={team.error} onRetry={() => void team.refetch()} />
      ) : (
        <>
          <OutcomeLine outcome={outcome} />
          {manages && <TeamSettings team={team.data} onOutcome={setOutcome} />}
          <TeamMembers
            team={team.data}
            manages={manages}
            onOutcome={setOutcome}
          />
          {manages && (
            <TeamDangerZone team={team.data} onOutcome={setOutcome} />
          )}
        </>
      )}
    </div>
  );
}

function TeamSettings({
  team,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [name, setName] = useState(team.name);
  const path = { params: { path: { team_id: team.id } } };

  const fail = (error: ApiError) =>
    onOutcome({
      kind: "error",
      text:
        error.code === "ALREADY_EXISTS"
          ? t("teams.nameTaken")
          : refusalText(t, error, "team.manage", role),
    });

  const rename = useMutation<TeamChangeResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.PATCH("/v1/teams/{team_id}", {
          ...path,
          body: { name: name.trim() },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async ({ team: renamed }) => {
      onOutcome({
        kind: "notice",
        text: t("teams.renamed", { name: renamed.name }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).teams,
      });
    },
    onError: fail,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate();
  };

  return (
    <SettingsCard title={t("teams.settings")} titleAs="h3">
      <form className={INLINE_FORM} onSubmit={submit}>
        <TeamNameField value={name} onChange={setName} />
        <Button
          type="submit"
          variant="outline"
          disabled={rename.isPending || name.trim() === team.name}
        >
          {t("teams.rename")}
        </Button>
      </form>
    </SettingsCard>
  );
}

/** Deleting the team, last on the page, in the settings' danger zone. */
function TeamDangerZone({
  team,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const role = useRole();
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE("/v1/teams/{team_id}", {
          params: { path: { team_id: team.id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setConfirming(false);
      queryClient.removeQueries({
        queryKey: queryKeysOf(client).team(team.id),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).teams,
      });
      await navigate({ to: "/members/teams" });
    },
    onError: (error) => {
      setConfirming(false);
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "team.manage", role),
      });
    },
  });

  return (
    <>
      <DangerZone titleAs="h3">
        <SettingRow
          title={t("teams.delete")}
          description={t("teams.deleteHint")}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-12 text-(color:--ap-tone-danger-fg)"
              disabled={remove.isPending}
              onClick={() => setConfirming(true)}
            >
              {t("teams.delete")}
            </Button>
          }
        />
      </DangerZone>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("teams.deleteTitle", { name: team.name })}
        consequence={t("teams.deleteConsequence")}
        confirmLabel={t("teams.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function TeamMembers({
  team,
  manages,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly manages: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  // Managers read every member with the page: the table's roles and the
  // picker's people both come from it. A team's own members never ask.
  const members = useQuery({ ...membersQuery(client), enabled: manages });
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const remove = useMutation<TeamChangeResponse, ApiError, TeamMember>({
    mutationFn: (member) =>
      unwrap(
        client.DELETE("/v1/teams/{team_id}/members/{user_id}", {
          params: { path: { team_id: team.id, user_id: member.user_id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSettled: () => setRemoving(null),
    onSuccess: async (_result, member) => {
      onOutcome({
        kind: "notice",
        text: t("teams.memberRemoved", {
          name: member.display_name ?? member.email,
        }),
      });
      await refreshTeam(queryClient, client, team.id);
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "team.manage", role),
      }),
  });

  const roles = members.isSuccess
    ? new Map(members.data.items.map((member) => [member.user_id, member.role]))
    : undefined;
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const shown = needle
    ? team.members.filter((member) => matches(member, needle))
    : team.members;
  // Below 640px the date drops out; the name keeps what the role and the
  // button leave.
  const columns = [
    "minmax(0,1fr)",
    roles && "112px",
    "minmax(9.5rem,0.5fr)",
    manages && "var(--ap-row-action-min-width)",
  ]
    .filter(Boolean)
    .join(" ");
  const narrowColumns = [
    "minmax(0,1fr)",
    roles && "72px",
    manages && "var(--ap-row-action-min-width)",
  ]
    .filter(Boolean)
    .join(" ");
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };

  return (
    <SettingsCard
      title={t("teams.members")}
      titleAs="h3"
      badge={
        <Badge variant="gray">
          {t("teams.memberTotal", { count: team.members.length })}
        </Badge>
      }
      {...(manages && { description: t("teams.addHint") })}
    >
      {manages && (
        <AddMembers team={team} members={members} onOutcome={onOutcome} />
      )}
      {team.members.length === 0 ? (
        <EmptyState title={t("teams.noMembers")} />
      ) : (
        <div className="flex flex-col gap-3">
          {/* SearchInput sizes itself as an item of a toolbar row. */}
          <div className="flex">
            <SearchInput
              ref={search}
              type="search"
              aria-label={t("teams.search")}
              placeholder={t("teams.search")}
              maxLength={SEARCH_MAX}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState
              className="w-full"
              title={t("teams.noMatch")}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={clear}
                >
                  {t("members.clearSearch")}
                </Button>
              }
            />
          ) : (
            <div className="rounded-card border bg-card">
              <GridTable
                aria-label={t("teams.tableLabel")}
                columns={columns}
                narrowAt={640}
                narrowColumns={narrowColumns}
              >
                <GridTableHeader>
                  <GridTableColumnHeader>
                    {t("members.column.name")}
                  </GridTableColumnHeader>
                  {roles && (
                    <GridTableColumnHeader>
                      {t("members.column.role")}
                    </GridTableColumnHeader>
                  )}
                  <GridTableColumnHeader hideNarrow={true}>
                    {t("teams.column.addedAt")}
                  </GridTableColumnHeader>
                  {manages && (
                    <GridTableColumnHeader align="end">
                      {t("members.column.actions")}
                    </GridTableColumnHeader>
                  )}
                </GridTableHeader>
                {shown.map((member) => {
                  const name = member.display_name ?? member.email;
                  const memberRole = roles?.get(member.user_id);
                  return (
                    <GridTableRow key={member.user_id}>
                      <GridTableCell>
                        <Avatar
                          initials={avatarInitials(name)}
                          tone={avatarTone(member.user_id)}
                        />
                        <span className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
                          <span className="truncate font-medium">{name}</span>
                          {member.display_name !== null && (
                            <span
                              className="truncate text-muted-foreground text-xs"
                              title={member.email}
                            >
                              {member.email}
                            </span>
                          )}
                        </span>
                      </GridTableCell>
                      {roles && (
                        <GridTableCell>
                          {memberRole && (
                            <Badge
                              variant={
                                memberRole === "member" ? "gray" : "blue"
                              }
                            >
                              {roleLabel(t, memberRole)}
                            </Badge>
                          )}
                        </GridTableCell>
                      )}
                      <GridTableCell
                        hideNarrow={true}
                        className="text-caption text-muted-foreground tabular-nums"
                      >
                        {formatTimestamp(member.added_at, locale)}
                      </GridTableCell>
                      {manages && (
                        <GridTableCell align="end">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-w-[var(--ap-row-action-min-width)]"
                            disabled={remove.isPending}
                            aria-label={t("teams.removeMemberFor", { name })}
                            onClick={() => setRemoving(member)}
                          >
                            {t("teams.removeMember")}
                          </Button>
                        </GridTableCell>
                      )}
                    </GridTableRow>
                  );
                })}
              </GridTable>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("teams.removeMemberTitle", {
          name: removing?.display_name ?? removing?.email ?? "",
          team: team.name,
        })}
        consequence={t("teams.removeMemberConsequence")}
        confirmLabel={t("teams.removeMember")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      />
    </SettingsCard>
  );
}

function refreshTeam(
  queryClient: ReturnType<typeof useQueryClient>,
  client: ReturnType<typeof useAgentPlatform>["client"],
  teamId: string,
) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeysOf(client).team(teamId),
    }),
    queryClient.invalidateQueries({ queryKey: queryKeysOf(client).teams }),
  ]);
}

type AddResult = {
  readonly added: readonly MemberView[];
  readonly failed: readonly {
    readonly member: MemberView;
    readonly error: ApiError;
  }[];
};

/**
 * Search by name or email, pick as many as needed, add them in one go. The
 * API takes one person per request, so the picks go one after another and
 * whoever was refused stays picked, ready to try again.
 */
function AddMembers({
  team,
  members,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly members: {
    readonly data?: { readonly items: readonly MemberView[] } | undefined;
    readonly error: unknown;
    readonly isPending: boolean;
    readonly isSuccess: boolean;
  };
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [picked, setPicked] = useState<readonly MemberView[]>([]);
  const pickerId = useId();

  const add = useMutation<AddResult, never, readonly MemberView[]>({
    mutationFn: async (people) => {
      const added: MemberView[] = [];
      const failed: { member: MemberView; error: ApiError }[] = [];
      for (const member of people) {
        try {
          await unwrap(
            client.POST("/v1/teams/{team_id}/members", {
              params: { path: { team_id: team.id } },
              body: { user_id: member.user_id },
            }),
          );
          added.push(member);
        } catch (error) {
          failed.push({ member, error: error as ApiError });
        }
      }
      return { added, failed };
    },
    onMutate: () => onOutcome(null),
    onSuccess: async ({ added, failed }) => {
      // Only who joined leaves the picks: the refused stay for a retry, and
      // anyone picked while the requests ran waits for the next one.
      const joined = new Set(added.map((member) => member.user_id));
      setPicked((list) => list.filter((member) => !joined.has(member.user_id)));
      const [first] = added;
      const said = [
        added.length === 1 && first
          ? t("teams.memberAdded", { name: first.display_name })
          : added.length > 1
            ? t("teams.membersAdded", { count: added.length })
            : null,
        failed[0]
          ? t("teams.addFailed", {
              names: failed.map(({ member }) => member.display_name).join(", "),
              reason: refusalText(t, failed[0].error, "team.manage", role),
            })
          : null,
      ].filter((line) => line !== null);
      onOutcome({
        kind: failed.length > 0 ? "error" : "notice",
        text: said.join(" "),
      });
      if (added.length > 0) await refreshTeam(queryClient, client, team.id);
    },
  });

  const taken = new Set([
    ...team.members.map((member) => member.user_id),
    ...picked.map((member) => member.user_id),
  ]);
  // Only active people can be added; a disabled membership is refused.
  const candidates =
    members.data?.items.filter(
      (member) => member.disabled_at === null && !taken.has(member.user_id),
    ) ?? [];
  const reason = members.error
    ? refusalText(t, members.error as ApiError, "member.manage", role)
    : undefined;
  const nothingLeft =
    members.isSuccess && candidates.length === 0 && picked.length === 0;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (picked.length > 0 && !add.isPending) add.mutate(picked);
      }}
    >
      <FieldLabel htmlFor={pickerId}>{t("teams.pickMember")}</FieldLabel>
      {/* As wide as the name's row above, so both buttons end in one line. */}
      <div className="flex max-w-xl flex-wrap items-center gap-2">
        <Combobox
          id={pickerId}
          className={NAME_FIELD}
          options={candidates.map((member) => ({
            value: member.user_id,
            label: member.display_name,
            description: member.email,
          }))}
          value={null}
          clearOnSelect={true}
          onValueChange={(value) => {
            const member = candidates.find((m) => m.user_id === value);
            if (member) setPicked((list) => [...list, member]);
          }}
          placeholder={t("teams.pickPlaceholder")}
          loading={members.isPending}
          loadingMessage={t("teams.pickLoading")}
          emptyMessage={t(
            members.isSuccess && candidates.length === 0
              ? "teams.noCandidates"
              : "teams.pickEmpty",
          )}
          resultCountMessage={(count) => t("teams.pickCount", { count })}
        />
        <ReasonButton
          type="submit"
          className={buttonVariants({ variant: "outline" })}
          reason={reason}
          disabled={picked.length === 0 || add.isPending}
        >
          {picked.length > 1
            ? t("teams.addMembers", { count: picked.length })
            : t("teams.addMember")}
        </ReasonButton>
      </div>
      {picked.length > 0 && (
        <ul
          aria-label={t("teams.picked")}
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
        >
          {picked.map((member) => (
            <li
              key={member.user_id}
              className="inline-flex items-center gap-1 rounded-full border bg-surface-sunken py-0.5 ps-2.5 pe-0.5 text-caption"
            >
              <span className="max-w-48 truncate" title={member.email}>
                {member.display_name}
              </span>
              <button
                type="button"
                className="inline-grid size-5 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-50"
                aria-label={t("teams.unpick", { name: member.display_name })}
                disabled={add.isPending}
                onClick={() => {
                  setPicked((list) =>
                    list.filter((m) => m.user_id !== member.user_id),
                  );
                  // The button leaves with its person; the search box keeps the keyboard.
                  document.getElementById(pickerId)?.focus();
                }}
              >
                <X aria-hidden="true" className="size-3" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {nothingLeft && (
        <p className={`${MUTED} m-0 text-caption`}>{t("teams.noCandidates")}</p>
      )}
    </form>
  );
}
