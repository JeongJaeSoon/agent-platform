import type {
  AgentAdminChangeResponse,
  AgentAdminKind,
} from "@agent-platform/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import {
  administeredAgentsQuery,
  agentAdminsQuery,
  membersQuery,
  queryKeys,
  teamsQuery,
} from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  refusalText,
  useHasPermission,
  usePermissionReason,
  useRole,
} from "../auth/guard.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";
import type { Outcome } from "./outcome.tsx";
import { StatusScreen } from "./status-screen.tsx";

/**
 * Who administers an agent: people and teams (design 4.1). Owners and admins
 * hold the right on every agent; anyone else only on the agents they already
 * administer, which /v1/administered-agents answers without leaving a refused
 * decision behind. The list itself is the probe for everyone else.
 */
export function AgentAdmins({
  agentId,
  onOutcome,
}: {
  readonly agentId: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useServices();
  const role = useRole();
  const everywhere = useHasPermission("agent.admin.manage");
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
  const mine =
    everywhere ||
    (administered.data?.items.some((agent) => agent.id === agentId) ?? false);
  const titleId = useId();

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("agentAdmins.title")}</h2>
      <p className="web-field__hint">{t("agentAdmins.intro")}</p>
      {mine ? (
        <AdminList agentId={agentId} onOutcome={onOutcome} />
      ) : administered.isPending && !everywhere ? (
        <StatusScreen kind="loading" />
      ) : administered.error ? (
        <p className="web-form__error" role="alert">
          {t(errorKey((administered.error as ApiError).code))}
        </p>
      ) : (
        <p className="web-guarded__reason">
          {permissionReason(t, "agent.admin.manage", role)}
        </p>
      )}
    </section>
  );
}

function AdminList({
  agentId,
  onOutcome,
}: {
  readonly agentId: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  const admins = useQuery(agentAdminsQuery(client, agentId));
  const reason = usePermissionReason("agent.admin.manage", admins);
  // Asked only of roles that can list them, so an agent's own admin does
  // not leave a refused decision on every visit.
  const listsMembers = useHasPermission("member.manage");
  const listsTeams = useHasPermission("team.manage");
  const members = useQuery({ ...membersQuery(client), enabled: listsMembers });
  const teams = useQuery({ ...teamsQuery(client), enabled: listsTeams });
  const [person, setPerson] = useState("");
  const [team, setTeam] = useState("");
  const personId = useId();
  const teamId = useId();

  const change = useMutation<
    AgentAdminChangeResponse,
    ApiError,
    { add: boolean; kind: AgentAdminKind; id: string; name: string }
  >({
    mutationFn: ({ add, kind, id }) =>
      unwrap(
        add
          ? client.POST("/v1/agents/{id}/admins", {
              params: { path: { id: agentId } },
              body: kind === "users" ? { user_id: id } : { team_id: id },
            })
          : client.DELETE("/v1/agents/{id}/admins/{kind}/{subject_id}", {
              params: { path: { id: agentId, kind, subject_id: id } },
            }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (result, { add, kind, name }) => {
      queryClient.setQueryData(queryKeys.agentAdmins(agentId), result.admins);
      if (kind === "users") setPerson("");
      else setTeam("");
      onOutcome({
        kind: "notice",
        text: t(add ? "agentAdmins.added" : "agentAdmins.removed", { name }),
      });
      // Naming or dropping the caller (or their team) changes what they
      // administer.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.administeredAgents,
      });
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "agent.admin.manage", role),
      }),
  });

  if (admins.isPending) return <StatusScreen kind="loading" />;
  if (admins.error) {
    return isApiError(admins.error, "FORBIDDEN") ? (
      <p className="web-guarded__reason">{reason}</p>
    ) : (
      <p className="web-form__error" role="alert">
        {t(errorKey((admins.error as ApiError).code))}
      </p>
    );
  }

  const userIds = new Set(admins.data.users.map((user) => user.user_id));
  const teamIds = new Set(admins.data.teams.map((row) => row.team_id));
  const people =
    members.data?.items.filter(
      (member) => member.disabled_at === null && !userIds.has(member.user_id),
    ) ?? [];
  const groups = teams.data?.items.filter((row) => !teamIds.has(row.id)) ?? [];
  const pickedPerson = people.find((member) => member.user_id === person);
  const pickedTeam = groups.find((row) => row.id === team);
  // Picking needs the member and team lists, which only owners and admins
  // read; an agent's own admin sees why the pickers stay closed.
  const personReason = !listsMembers
    ? permissionReason(t, "member.manage", role)
    : members.error
      ? refusalText(t, members.error as ApiError, "member.manage", role)
      : undefined;
  const teamReason = !listsTeams
    ? permissionReason(t, "team.manage", role)
    : teams.error
      ? refusalText(t, teams.error as ApiError, "team.manage", role)
      : undefined;

  return (
    <>
      {admins.data.users.length + admins.data.teams.length === 0 ? (
        <p className="web-page__empty">{t("agentAdmins.empty")}</p>
      ) : (
        <ul className="web-list">
          {admins.data.users.map((user) => {
            const name = user.display_name ?? user.email;
            return (
              <li key={`u:${user.user_id}`} className="web-list__item">
                <span className="web-table__primary">{name}</span>
                <span className="web-table__secondary">
                  {t("agentAdmins.person")} · {user.email}
                </span>
                <button
                  type="button"
                  className="ap-button"
                  disabled={change.isPending}
                  aria-label={t("agentAdmins.removeFor", { name })}
                  onClick={() =>
                    change.mutate({
                      add: false,
                      kind: "users",
                      id: user.user_id,
                      name,
                    })
                  }
                >
                  {t("agentAdmins.remove")}
                </button>
              </li>
            );
          })}
          {admins.data.teams.map((row) => (
            <li key={`t:${row.team_id}`} className="web-list__item">
              <span className="web-table__primary">{row.name}</span>
              <span className="web-table__secondary">
                {t("agentAdmins.team")}
              </span>
              <button
                type="button"
                className="ap-button"
                disabled={change.isPending}
                aria-label={t("agentAdmins.removeFor", { name: row.name })}
                onClick={() =>
                  change.mutate({
                    add: false,
                    kind: "teams",
                    id: row.team_id,
                    name: row.name,
                  })
                }
              >
                {t("agentAdmins.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="web-form web-form--inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (pickedPerson)
            change.mutate({
              add: true,
              kind: "users",
              id: pickedPerson.user_id,
              name: pickedPerson.display_name,
            });
        }}
      >
        <label className="web-field" htmlFor={personId}>
          <span>{t("agentAdmins.pickPerson")}</span>
          <select
            id={personId}
            className="ap-input"
            value={person}
            disabled={people.length === 0}
            onChange={(event) => setPerson(event.target.value)}
          >
            <option value="">{t("agentAdmins.pickPlaceholder")}</option>
            {people.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.display_name} ({member.email})
              </option>
            ))}
          </select>
        </label>
        <ReasonButton
          type="submit"
          reason={personReason}
          disabled={!pickedPerson || change.isPending}
        >
          {t("agentAdmins.addPerson")}
        </ReasonButton>
      </form>
      <form
        className="web-form web-form--inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (pickedTeam)
            change.mutate({
              add: true,
              kind: "teams",
              id: pickedTeam.id,
              name: pickedTeam.name,
            });
        }}
      >
        <label className="web-field" htmlFor={teamId}>
          <span>{t("agentAdmins.pickTeam")}</span>
          <select
            id={teamId}
            className="ap-input"
            value={team}
            disabled={groups.length === 0}
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value="">{t("agentAdmins.pickPlaceholder")}</option>
            {groups.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <ReasonButton
          type="submit"
          reason={teamReason}
          disabled={!pickedTeam || change.isPending}
        >
          {t("agentAdmins.addTeam")}
        </ReasonButton>
      </form>
    </>
  );
}
