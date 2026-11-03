import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { Agent, SetAgentManagingTeamResponse } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  NativeSelect,
  NativeSelectOption,
  Section,
  Text,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import {
  agentAdminsQuery,
  agentListsFilter,
  myTeamsQuery,
  queryKeysOf,
  teamQuery,
  teamsQuery,
} from "../api/queries.ts";
import {
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";
import type { Outcome } from "./outcome.tsx";
import { SECTION_BODY } from "./section-body.ts";

/** A team someone may name as an agent's managing team. */
export interface TeamChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * The teams the viewer may make a managing team: every team for owners and
 * admins, who list them all; anyone else only the teams they are in, which
 * is all the server takes from them.
 */
export function useTeamChoices() {
  const { client } = useAgentPlatform();
  const everywhere = useHasPermission("team.manage");
  const all = useQuery({ ...teamsQuery(client), enabled: everywhere });
  const mine = useQuery({ ...myTeamsQuery(client), enabled: !everywhere });
  const read = everywhere ? all : mine;
  return {
    everywhere,
    choices: read.data?.items.map(
      (team): TeamChoice => ({ id: team.id, name: team.name }),
    ),
    error: read.error,
    refetch: () => void read.refetch(),
  };
}

/** The agent's managing team, or the mark of an agent that has none. */
export function ManagingTeamName({ agent }: { readonly agent: Agent }) {
  const { t } = useI18n();
  return agent.managing_team_name === null ? (
    <Badge variant="amber">{t("managingTeam.unassigned")}</Badge>
  ) : (
    <Text as="span" className="[overflow-wrap:anywhere]">
      {agent.managing_team_name}
    </Text>
  );
}

/**
 * The admins tab's first section: who the managing team is, and for those
 * who manage the agent, the way to name another one.
 */
export function ManagingTeam({
  agent,
  manages,
  onOutcome,
}: {
  readonly agent: Agent;
  readonly manages: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  return (
    <Section
      title={t("managingTeam.title")}
      description={t("managingTeam.intro")}
    >
      <div className={SECTION_BODY}>
        <div className="flex flex-wrap items-center gap-2">
          <ManagingTeamName agent={agent} />
        </div>
        {agent.managing_team_id === null ? (
          <Text variant="meta">{t("managingTeam.unassignedHint")}</Text>
        ) : (
          <NoLeadNotice teamId={agent.managing_team_id} />
        )}
        {manages ? <ChangeTeam agent={agent} onOutcome={onOutcome} /> : null}
      </div>
    </Section>
  );
}

/** Said only when the team's members can be read: owners, admins, its own. */
function NoLeadNotice({ teamId }: { readonly teamId: string }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const everywhere = useHasPermission("team.manage");
  const mine = useQuery({ ...myTeamsQuery(client), enabled: !everywhere });
  const readable =
    everywhere ||
    (mine.data?.items.some((team) => team.id === teamId) ?? false);
  const team = useQuery({ ...teamQuery(client, teamId), enabled: readable });
  if (!team.data || team.data.members.some((m) => m.role === "lead"))
    return null;
  return (
    <Alert variant="amber">
      <AlertDescription>{t("managingTeam.noLead")}</AlertDescription>
    </Alert>
  );
}

function ChangeTeam({
  agent,
  onOutcome,
}: {
  readonly agent: Agent;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const limited =
    useMe()?.workspace?.settings.agent_outsider_session_visibility ===
    "managing_team";
  const { choices, error, refetch } = useTeamChoices();
  const admins = useQuery(agentAdminsQuery(client, agent.id));
  const [picked, setPicked] = useState("");
  const selectId = useId();
  const others = choices?.filter((team) => team.id !== agent.managing_team_id);
  // The one admin team, when it is the obvious managing team (design (d)).
  const adminTeams = admins.data?.teams ?? [];
  const adminTeam =
    agent.managing_team_id === null && adminTeams.length === 1
      ? choices?.find((team) => team.id === adminTeams[0]?.team_id)
      : undefined;

  const set = useMutation<SetAgentManagingTeamResponse, ApiError, TeamChoice>({
    mutationFn: (team) =>
      unwrap(
        client.PUT("/v1/agents/{id}/managing-team", {
          params: { path: { id: agent.id } },
          body: { team_id: team.id },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (_result, team) => {
      setPicked("");
      onOutcome({
        kind: "notice",
        text: t("managingTeam.saved", { name: team.name }),
      });
      // The team decides who leads the agent and who reads it, so every
      // read that judged the viewer by the old one goes stale.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).agent(agent.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).agentAdmins(agent.id),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).administeredAgents,
        }),
        queryClient.invalidateQueries(agentListsFilter(client)),
      ]);
    },
    onError: (failure) =>
      onOutcome({
        kind: "error",
        text:
          (failure.details as { reason_code?: unknown } | null)?.reason_code ===
          "team_not_allowed"
            ? t("managingTeam.notAllowed")
            : refusalText(t, failure, "agent.admin.manage", role),
      }),
  });

  if (error) return <LoadFailure error={error} onRetry={refetch} />;
  if (others === undefined) return null;
  const choice = others.find((team) => team.id === picked);
  return (
    <div className="flex flex-col gap-3">
      {adminTeam ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={set.isPending}
            onClick={() => set.mutate(adminTeam)}
          >
            {t("managingTeam.recommend", { name: adminTeam.name })}
          </Button>
        </div>
      ) : null}
      {others.length === 0 ? (
        <Text variant="meta">{t("managingTeam.noChoices")}</Text>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice) set.mutate(choice);
          }}
        >
          <label className="sr-only" htmlFor={selectId}>
            {t("managingTeam.pick")}
          </label>
          <NativeSelect
            id={selectId}
            className="w-auto max-w-full"
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
          >
            <NativeSelectOption value="" disabled>
              {t("managingTeam.pickPlaceholder")}
            </NativeSelectOption>
            {others.map((team) => (
              <NativeSelectOption key={team.id} value={team.id}>
                {team.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!choice || set.isPending}
          >
            {set.isPending
              ? t("managingTeam.saving")
              : t(
                  agent.managing_team_id === null
                    ? "managingTeam.assign"
                    : "managingTeam.change",
                )}
          </Button>
        </form>
      )}
      {limited ? (
        <Text variant="meta">{t("managingTeam.audience")}</Text>
      ) : null}
    </div>
  );
}
