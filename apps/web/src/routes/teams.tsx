import type {
  MemberView,
  TeamChangeResponse,
  TeamDetail,
} from "@agent-platform/contracts";
import { ConfirmDialog, formatTimestamp } from "@agent-platform/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
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
import { TextField } from "../components/field.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

function ListError({ error }: { readonly error: unknown }) {
  const { t } = useI18n();
  return isApiError(error, "FORBIDDEN") ? (
    <StatusScreen kind="forbidden" />
  ) : (
    <p className="web-form__error" role="alert">
      {t(errorKey((error as ApiError).code))}
    </p>
  );
}

/** Teams: groups of people an owner or admin manages (design 4.7). */
export function TeamsScreen() {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  const manages = useHasPermission("team.manage");
  const teams = useQuery({ ...teamsQuery(client), enabled: manages });
  const reason = usePermissionReason("team.manage", teams);
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
      <div className="web-page">
        <h1 className="web-page__title">{t("teams.title")}</h1>
        <p className="web-page__intro">{t("teams.intro")}</p>
        <MyTeams showEmpty />
      </div>
    );
  }

  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("teams.title")}</h1>
      <p className="web-page__intro">{t("teams.intro")}</p>
      <OutcomeLine outcome={outcome} />
      <form className="web-form web-form--inline" onSubmit={submit}>
        <TextField
          label={t("teams.name")}
          name="team-name"
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <ReasonButton
          type="submit"
          className="ap-button ap-button--primary"
          reason={reason}
          disabled={create.isPending}
        >
          {create.isPending ? t("teams.creating") : t("teams.create")}
        </ReasonButton>
      </form>
      <section className="web-section" aria-labelledby={titleId}>
        <h2 id={titleId}>{t("teams.listTitle")}</h2>
        {teams.isPending ? (
          <StatusScreen kind="loading" />
        ) : teams.error ? (
          <ListError error={teams.error} />
        ) : teams.data.items.length === 0 ? (
          <p className="web-page__empty">{t("teams.empty")}</p>
        ) : (
          <ul className="web-list">
            {teams.data.items.map((team) => (
              <li key={team.id} className="web-list__item">
                <Link
                  to="/teams/$teamId"
                  params={{ teamId: team.id }}
                  className="web-table__primary"
                >
                  {team.name}
                </Link>
                <span className="web-table__secondary">
                  {t("teams.memberCount", { count: team.member_count })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {isApiError(teams.error, "FORBIDDEN") ? <MyTeams showEmpty /> : null}
    </div>
  );
}

export function TeamDetailScreen() {
  const { teamId } = useParams({ from: "/authed/teams/$teamId" });
  return <TeamPage key={teamId} id={teamId} />;
}

function TeamPage({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const { client } = useServices();
  const team = useQuery(teamQuery(client, id));
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  return (
    <div className="web-page">
      <p className="web-page__back">
        <Link to="/teams">{t("teams.back")}</Link>
      </p>
      {team.isPending ? (
        <StatusScreen kind="loading" />
      ) : team.error ? (
        <ListError error={team.error} />
      ) : (
        <>
          <h1 className="web-page__title">{team.data.name}</h1>
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
  const { client, queryClient } = useServices();
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
      await navigate({ to: "/teams" });
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
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("teams.settings")}</h2>
      <form className="web-form web-form--inline" onSubmit={submit}>
        <TextField
          label={t("teams.name")}
          name="team-name"
          required
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          className="ap-button"
          disabled={rename.isPending || name.trim() === team.name}
        >
          {t("teams.rename")}
        </button>
      </form>
      <p className="web-field__hint">{t("teams.deleteHint")}</p>
      <button
        type="button"
        className="ap-button ap-button--danger"
        disabled={remove.isPending}
        onClick={() => setConfirming(true)}
      >
        {t("teams.delete")}
      </button>
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
  const { client, queryClient } = useServices();
  const role = useRole();
  const members = useQuery(membersQuery(client));
  const [picked, setPicked] = useState("");
  const titleId = useId();
  const pickId = useId();

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
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("teams.members")}</h2>
      <p className="web-field__hint">{t("teams.addHint")}</p>
      <form
        className="web-form web-form--inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen) add.mutate(chosen);
        }}
      >
        <label className="web-field" htmlFor={pickId}>
          <span>{t("teams.pickMember")}</span>
          <select
            id={pickId}
            className="ap-input"
            value={picked}
            disabled={candidates.length === 0}
            onChange={(event) => setPicked(event.target.value)}
          >
            <option value="">{t("teams.pickPlaceholder")}</option>
            {candidates.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.display_name} ({member.email})
              </option>
            ))}
          </select>
        </label>
        <ReasonButton
          type="submit"
          reason={pickReason}
          disabled={!chosen || add.isPending}
        >
          {t("teams.addMember")}
        </ReasonButton>
      </form>
      {team.members.length === 0 ? (
        <p className="web-page__empty">{t("teams.noMembers")}</p>
      ) : (
        <ul className="web-list">
          {team.members.map((member) => {
            const name = member.display_name ?? member.email;
            return (
              <li key={member.user_id} className="web-list__item">
                <span className="web-table__primary">{name}</span>
                <span className="web-table__secondary">
                  {member.email} ·{" "}
                  {t("teams.addedAt", {
                    at: formatTimestamp(member.added_at, locale),
                  })}
                </span>
                <button
                  type="button"
                  className="ap-button"
                  disabled={remove.isPending}
                  aria-label={t("teams.removeMemberFor", { name })}
                  onClick={() => remove.mutate(member)}
                >
                  {t("teams.removeMember")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
