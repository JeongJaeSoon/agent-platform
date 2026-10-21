import type { Agent, WorkspaceRole } from "@agent-platform/contracts";
import type { TeamActor } from "./team-store.ts";

export type AgentAdminSubject = { kind: "user" | "team"; id: string };

export type AgentAdmins = {
  users: {
    userId: string;
    email: string;
    displayName: string | null;
    createdBy: string | null;
    createdAt: Date;
  }[];
  teams: {
    teamId: string;
    name: string;
    createdBy: string | null;
    createdAt: Date;
  }[];
};

/**
 * `subject_not_found`: no live member or live team by that id in the agent's
 * workspace. `unchanged`: already an admin (add) or already not (remove).
 */
export type AgentAdminChangeResult =
  | { outcome: "added" | "removed" | "unchanged"; admins: AgentAdmins }
  | { outcome: "not_found" | "subject_not_found" | "actor_inactive" };

export interface AgentAdminStore {
  list(workspaceId: string, agentId: string): Promise<AgentAdmins | null>;
  /**
   * `managerRoles` are the roles that hold the right outright; anyone else
   * must still administer the agent, re-read under a share lock.
   */
  add(input: {
    actor: TeamActor;
    receiptId: string;
    agentId: string;
    subject: AgentAdminSubject;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<AgentAdminChangeResult>;
  remove(input: {
    actor: TeamActor;
    receiptId: string;
    agentId: string;
    subject: AgentAdminSubject;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<AgentAdminChangeResult>;
  /** The agents this person administers, directly or through a team. */
  listAdministered(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<Agent[]>;
}
