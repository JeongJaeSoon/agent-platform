import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  AgentAdminChangeResponse,
  AgentAdminKind,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  ConfirmDialog,
  EmptyState,
  RowList,
  RowListItem,
  Link as TextLink,
} from "@werft-ai/ui";
import { useId, useState } from "react";
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
  useMe,
  usePermissionReason,
  useRole,
} from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";
import type { Outcome } from "./outcome.tsx";
import { StatusScreen } from "./status-screen.tsx";

// Lines that wrap on a narrow screen sit a line gap apart, not RowListItem's 8px.
const ADMIN_ROW = "gap-y-[var(--ap-row-line-gap)]";
const PRIMARY = "font-semibold [overflow-wrap:anywhere]";
const SECONDARY = "text-caption text-muted-foreground [overflow-wrap:anywhere]";

/**
 * Who administers an agent: people and teams (design 4.1). Owners and admins
 * hold the right on every agent; anyone else only on the agents they already
 * administer, which /v1/administered-agents answers without leaving a refused
 * decision behind. The list itself is the probe for everyone else.
 */
/** contracts TEAM_LIST_LIMIT: a list this long may have left agents out. */
export const ADMINISTERED_LIST_LIMIT = 200;

export function AgentAdmins({
  agentId,
  onOutcome,
}: {
  readonly agentId: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const everywhere = useHasPermission("agent.admin.manage");
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
  const items = administered.data?.items;
  // A full list may have cut this agent off; then the admin list itself
  // answers, at the cost of a refused decision row if it is not theirs.
  const mine =
    everywhere ||
    (items !== undefined &&
      (items.some((agent) => agent.id === agentId) ||
        items.length >= ADMINISTERED_LIST_LIMIT));
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
        <LoadFailure
          error={administered.error}
          onRetry={() => void administered.refetch()}
        />
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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const admins = useQuery(agentAdminsQuery(client, agentId));
  const reason = usePermissionReason("agent.admin.manage", admins);
  // Asked only of roles that can list them, so an agent's own admin does
  // not leave a refused decision on every visit.
  const listsMembers = useHasPermission("member.manage");
  const listsTeams = useHasPermission("team.manage");
  // Every member is read once someone reaches for the person picker, not
  // with the page.
  const [picking, setPicking] = useState(false);
  const members = useQuery({
    ...membersQuery(client),
    enabled: listsMembers && picking,
  });
  const teams = useQuery({ ...teamsQuery(client), enabled: listsTeams });
  const [person, setPerson] = useState("");
  const [team, setTeam] = useState("");
  const [removing, setRemoving] = useState<{
    kind: AgentAdminKind;
    id: string;
    name: string;
  } | null>(null);
  const me = useMe();
  // Owners and admins manage every agent whatever this list says.
  const everywhere = useHasPermission("agent.admin.manage");
  const losesAccess =
    !everywhere && removing?.kind === "users" && removing.id === me?.user?.id;
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
    onSettled: () => setRemoving(null),
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
      <LoadFailure error={admins.error} onRetry={() => void admins.refetch()} />
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
        <EmptyState title={t("agentAdmins.empty")} />
      ) : (
        <RowList>
          {admins.data.users.map((user) => {
            const name = user.display_name ?? user.email;
            return (
              <RowListItem key={`u:${user.user_id}`} className={ADMIN_ROW}>
                <span className={PRIMARY}>{name}</span>
                <span className={SECONDARY}>
                  {t("agentAdmins.person")} · {user.email}
                </span>
                <button
                  type="button"
                  className="ap-button ml-auto"
                  disabled={change.isPending}
                  aria-label={t("agentAdmins.removeFor", { name })}
                  onClick={() =>
                    setRemoving({ kind: "users", id: user.user_id, name })
                  }
                >
                  {t("agentAdmins.remove")}
                </button>
              </RowListItem>
            );
          })}
          {admins.data.teams.map((row) => (
            <RowListItem key={`t:${row.team_id}`} className={ADMIN_ROW}>
              <span className={PRIMARY}>{row.name}</span>
              <span className={SECONDARY}>{t("agentAdmins.team")}</span>
              <button
                type="button"
                className="ap-button ml-auto"
                disabled={change.isPending}
                aria-label={t("agentAdmins.removeFor", { name: row.name })}
                onClick={() =>
                  setRemoving({
                    kind: "teams",
                    id: row.team_id,
                    name: row.name,
                  })
                }
              >
                {t("agentAdmins.remove")}
              </button>
            </RowListItem>
          ))}
        </RowList>
      )}
      <form
        className="web-form web-form--inline"
        onPointerEnter={() => setPicking(true)}
        onFocus={() => setPicking(true)}
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
            disabled={
              !listsMembers ||
              (picking && !members.isPending && people.length === 0)
            }
            aria-busy={members.isFetching}
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
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("agentAdmins.removeTitle", { name: removing?.name ?? "" })}
        consequence={
          losesAccess
            ? t("agentAdmins.removeSelfConsequence")
            : t("agentAdmins.removeConsequence")
        }
        confirmLabel={t("agentAdmins.remove")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={change.isPending}
        onConfirm={() => {
          if (removing) change.mutate({ add: false, ...removing });
        }}
      />
    </>
  );
}

/**
 * The agents the viewer was named admin of. Owners and admins hold the right
 * on every agent, so a list of some would mislead them and they get nothing.
 */
export function AdministeredAgents({
  showEmpty,
}: {
  /** Off where an empty section would only be noise (home). */
  readonly showEmpty: boolean;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const everywhere = useHasPermission("agent.admin.manage");
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
  const titleId = useId();
  if (everywhere || administered.isPending) return null;
  const items = administered.data?.items ?? [];
  if (!administered.error && items.length === 0 && !showEmpty) return null;

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("agentAdmins.mine.title")}</h2>
      {administered.error ? (
        <LoadFailure
          error={administered.error}
          onRetry={() => void administered.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState title={t("agentAdmins.mine.empty")} />
      ) : (
        <>
          <p className="web-field__hint">{t("agentAdmins.mine.intro")}</p>
          <RowList>
            {items.map((agent) => (
              <RowListItem key={agent.id} className={ADMIN_ROW}>
                <TextLink asChild className={PRIMARY}>
                  <Link to="/agents/$id" params={{ id: agent.id }}>
                    {agent.name}
                  </Link>
                </TextLink>
                <span className={`${SECONDARY} ml-auto`}>{agent.slug}</span>
              </RowListItem>
            ))}
          </RowList>
          {items.length >= ADMINISTERED_LIST_LIMIT ? (
            <p className="web-field__hint">
              {t("agentAdmins.mine.truncated", {
                count: ADMINISTERED_LIST_LIMIT,
              })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
