import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { createContext, useContext } from "react";
import { agentAdminsQuery, myTeamsQuery } from "../api/queries.ts";
import { useHasPermission, useMe } from "../auth/guard.tsx";

/**
 * What the viewer does with an agent whose settings they read: change them
 * (owners, admins, the agent's admins) or only read them (the managing
 * team's other members). Unknown while the reads that decide it load.
 */
export type AgentAccess = "manage" | "read" | "pending";

const ManagesAgent = createContext(true);

/** Set by the agent's page; anywhere else the viewer made the agent. */
export const ManagesAgentProvider = ManagesAgent.Provider;

/** Whether the settings shown here take changes from the viewer. */
export function useManagesAgent(): boolean {
  return useContext(ManagesAgent);
}

/**
 * The server's agent-admin rule read from what the viewer may read: an admin
 * row naming them, an admin team they are in, or the lead role in the
 * managing team. /v1/administered-agents stops at a page, so it cannot say
 * no for every agent.
 */
export function useAgentAccess(agent: Agent): AgentAccess {
  const { client } = useAgentPlatform();
  const everywhere = useHasPermission("agent.manage");
  const me = useMe()?.user?.id;
  const admins = useQuery({
    ...agentAdminsQuery(client, agent.id),
    enabled: !everywhere,
  });
  const mine = useQuery({ ...myTeamsQuery(client), enabled: !everywhere });
  if (everywhere) return "manage";
  // A failed read shows no change controls; the server would judge anyway.
  if (admins.isError || mine.isError) return "read";
  if (!admins.data || !mine.data || me === undefined) return "pending";
  const roles = new Map(mine.data.items.map((team) => [team.id, team.role]));
  const manages =
    admins.data.users.some((user) => user.user_id === me) ||
    admins.data.teams.some((team) => roles.has(team.team_id)) ||
    (agent.managing_team_id !== null &&
      roles.get(agent.managing_team_id) === "lead");
  return manages ? "manage" : "read";
}
