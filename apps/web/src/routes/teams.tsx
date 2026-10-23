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
  Button,
  buttonVariants,
  ConfirmDialog,
  EmptyState,
  Field,
  FieldLabel,
  formatTimestamp,
  Input,
  NativeSelect,
  NativeSelectOption,
  RowList,
  RowListItem,
  Link as TextLink,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import {
  membersQuery,
  queryKeys,
  teamQuery,
  teamsQuery,
} from "../api/queries.ts";
import {
  ReasonButton,
  refusalText,
  useHasPermission,
  usePermissionReason,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import {
  MUTED,
  MyTeams,
  SECTION,
  SECTION_TITLE,
} from "../components/my-teams.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";

const FORM = "flex flex-col items-start gap-4";
const NAME_FIELD = "max-w-md";
const SECONDARY = "text-muted-foreground text-sm [overflow-wrap:anywhere]";

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
  const queryClient = useQueryClient();
  const role = useRole();
  const manages = useHasPermission("team.manage");
  const teams = useQuery({ ...teamsQuery(client), enabled: manages });
  const reason = usePermissionReason("team.manage", teams);
  // The list is also the permission probe: when it failed, nobody knows.
  const failed = teams.isError && !isApiError(teams.error, "FORBIDDEN");
  const [name, setName] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const titleId = useId();

  const create = useMutation<TeamChangeResponse, ApiError>({
    mutationFn: () =>
      unwrap(client.POST("/v1/teams", { body: { name: name.trim() } })),
    onMutate: () => setOutcome(null),
    onSuccess: async ({ team }) => {
      setName("");
      setOutcome({
        kind: "notice",
        text: t("teams.created", { name: team.name }),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams });
    },
    onError: (error) =>
      setOutcome({
        kind: "error",
        text:
          error.code === "ALREADY_EXISTS"
            ? t("teams.nameTaken")
            : refusalText(t, error, "team.manage", role),
      }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  if (!manages) {
    return (
      <TeamsTab>
        <MyTeams showEmpty />
      </TeamsTab>
    );
  }

  return (
    <TeamsTab>
      <OutcomeLine outcome={outcome} />
      {failed ? null : (
        <form className={FORM} onSubmit={submit}>
          <TeamNameField value={name} onChange={setName} />
          <ReasonButton
            type="submit"
            className={buttonVariants()}
            reason={reason}
            disabled={create.isPending}
          >
            {create.isPending ? t("teams.creating") : t("teams.create")}
          </ReasonButton>
        </form>
      )}
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
              <RowListItem key={team.id}>
                <TextLink asChild className="[overflow-wrap:anywhere]">
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
          <TeamSettings team={team.data} onOutcome={setOutcome} />
          <TeamMembers team={team.data} onOutcome={setOutcome} />
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
  const navigate = useNavigate();
  const role = useRole();
  const [name, setName] = useState(team.name);
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams });
    },
    onError: fail,
  });

  const remove = useMutation<unknown, ApiError>({
    mutationFn: () => unwrap(client.DELETE("/v1/teams/{team_id}", path)),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setConfirming(false);
      queryClient.removeQueries({ queryKey: queryKeys.team(team.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams });
      await navigate({ to: "/members/teams" });
    },
    onError: (error) => {
      setConfirming(false);
      fail(error);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate();
  };

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h3 id={titleId} className={SECTION_TITLE}>
        {t("teams.settings")}
      </h3>
      <form className={FORM} onSubmit={submit}>
        <TeamNameField value={name} onChange={setName} />
        <Button
          type="submit"
          variant="outline"
          disabled={rename.isPending || name.trim() === team.name}
        >
          {t("teams.rename")}
        </Button>
      </form>
      <p className={`${MUTED} text-sm`}>{t("teams.deleteHint")}</p>
      <Button
        type="button"
        variant="destructive"
        className="self-start"
        disabled={remove.isPending}
        onClick={() => setConfirming(true)}
      >
        {t("teams.delete")}
      </Button>
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
    </section>
  );
}

function TeamMembers({
  team,
  onOutcome,
}: {
  readonly team: TeamDetail;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const members = useQuery(membersQuery(client));
  const [picked, setPicked] = useState("");
  const [removing, setRemoving] = useState<
    TeamDetail["members"][number] | null
  >(null);
  const titleId = useId();

  const settle = async (text: string) => {
    onOutcome({ kind: "notice", text });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.team(team.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.teams }),
    ]);
  };
  const fail = (error: ApiError) =>
    onOutcome({
      kind: "error",
      text: refusalText(t, error, "team.manage", role),
    });

  const add = useMutation<TeamChangeResponse, ApiError, MemberView>({
    mutationFn: (member) =>
      unwrap(
        client.POST("/v1/teams/{team_id}/members", {
          params: { path: { team_id: team.id } },
          body: { user_id: member.user_id },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (_result, member) => {
      setPicked("");
      await settle(t("teams.memberAdded", { name: member.display_name }));
    },
    onError: fail,
  });

  const remove = useMutation<
    TeamChangeResponse,
    ApiError,
    TeamDetail["members"][number]
  >({
    mutationFn: (member) =>
      unwrap(
        client.DELETE("/v1/teams/{team_id}/members/{user_id}", {
          params: { path: { team_id: team.id, user_id: member.user_id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSettled: () => setRemoving(null),
    onSuccess: (_result, member) =>
      settle(
        t("teams.memberRemoved", {
          name: member.display_name ?? member.email,
        }),
      ),
    onError: fail,
  });

  const inTeam = new Set(team.members.map((member) => member.user_id));
  // Only active people can be added; a disabled membership is refused.
  const candidates =
    members.data?.items.filter(
      (member) => member.disabled_at === null && !inTeam.has(member.user_id),
    ) ?? [];
  const pickReason = members.error
    ? refusalText(t, members.error as ApiError, "member.manage", role)
    : candidates.length === 0 && members.isSuccess
      ? t("teams.noCandidates")
      : undefined;
  const chosen = candidates.find((member) => member.user_id === picked);

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h3 id={titleId} className={SECTION_TITLE}>
        {t("teams.members")}
      </h3>
      <p className={`${MUTED} text-sm`}>{t("teams.addHint")}</p>
      <form
        className={FORM}
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen) add.mutate(chosen);
        }}
      >
        <Field className="max-w-full">
          <FieldLabel>{t("teams.pickMember")}</FieldLabel>
          <NativeSelect
            value={picked}
            disabled={candidates.length === 0}
            onChange={(event) => setPicked(event.target.value)}
          >
            <NativeSelectOption value="">
              {t("teams.pickPlaceholder")}
            </NativeSelectOption>
            {candidates.map((member) => (
              <NativeSelectOption key={member.user_id} value={member.user_id}>
                {member.display_name} ({member.email})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <ReasonButton
          type="submit"
          className={buttonVariants({ variant: "outline" })}
          reason={pickReason}
          disabled={!chosen || add.isPending}
        >
          {t("teams.addMember")}
        </ReasonButton>
      </form>
      {team.members.length === 0 ? (
        <EmptyState title={t("teams.noMembers")} />
      ) : (
        <RowList>
          {team.members.map((member) => {
            const name = member.display_name ?? member.email;
            return (
              <RowListItem key={member.user_id}>
                <span className="font-medium [overflow-wrap:anywhere]">
                  {name}
                </span>
                <span className={SECONDARY}>
                  {member.email} ·{" "}
                  {t("teams.addedAt", {
                    at: formatTimestamp(member.added_at, locale),
                  })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  disabled={remove.isPending}
                  aria-label={t("teams.removeMemberFor", { name })}
                  onClick={() => setRemoving(member)}
                >
                  {t("teams.removeMember")}
                </Button>
              </RowListItem>
            );
          })}
        </RowList>
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
    </section>
  );
}
