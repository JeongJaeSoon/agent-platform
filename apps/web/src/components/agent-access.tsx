import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { createContext, useContext } from "react";
import { agentAdminsQuery, myTeamsQuery } from "../api/queries.ts";
import { useHasPermission, useMe } from "../auth/guard.tsx";

export type AgentAccess = "manage" | "read" | "pending";

const ManagesAgent = createContext(true);

export const ManagesAgentProvider = ManagesAgent.Provider;

export function useManagesAgent(): boolean {
  return useContext(ManagesAgent);
}

/**
 * The server's agent-admin rule read from what the viewer may read: an admin
 * row naming them, an admin team they are in, or the lead role in the
 * managing team.
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
