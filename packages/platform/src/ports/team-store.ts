import type { PaginationQuery } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

export type TeamPage<T> = { items: T[]; nextCursor: string | null };

export type Team = {
  id: string;
  workspaceId: string;
  name: string;
  createdBy: string | null;
  createdAt: Date;
  revision: number;
  memberCount: number;
};

export type TeamMember = {
  userId: string;
  email: string;
  displayName: string | null;
  addedBy: string | null;
  addedAt: Date;
};

export type TeamDetail = Team & { members: TeamMember[] };

/**
 * Who is changing a team. Each write re-reads, under a share lock, that this
 * person is still a live owner or admin of `workspaceId`.
 */
export type TeamActor = {
  principal: Principal;
  workspaceId: string;
  userId: string;
};

type Write = { actor: TeamActor; receiptId: string };

export type CreateTeamResult =
  | { outcome: "created"; team: Team }
  | { outcome: "name_taken" | "actor_inactive" };

export type RenameTeamResult =
  | { outcome: "renamed" | "unchanged"; team: Team }
  | { outcome: "not_found" | "name_taken" | "actor_inactive" };

export type DeleteTeamResult = {
  outcome: "deleted" | "not_found" | "actor_inactive";
};

/**
 * `not_member`: the person is not a live member of the team's workspace.
 * `unchanged`: already in (add) or already out (remove); no receipt.
 */
export type TeamMembershipResult =
  | { outcome: "added" | "removed" | "unchanged"; team: Team }
  | { outcome: "not_found" | "not_member" | "actor_inactive" };

export interface TeamStore {
  create(
    input: Write & { teamId: string; name: string },
  ): Promise<CreateTeamResult>;
  rename(
    input: Write & { teamId: string; name: string },
  ): Promise<RenameTeamResult>;
  /** Archives the team and drops every agent it administered. */
  delete(input: Write & { teamId: string }): Promise<DeleteTeamResult>;
  addMember(
    input: Write & { teamId: string; userId: string },
  ): Promise<TeamMembershipResult>;
  removeMember(
    input: Write & { teamId: string; userId: string },
  ): Promise<TeamMembershipResult>;
  /** One page by name, then id; a malformed cursor throws InvalidCursorError. */
  list(workspaceId: string, query: PaginationQuery): Promise<TeamPage<Team>>;
  get(workspaceId: string, teamId: string): Promise<TeamDetail | null>;
  /** One page of the live teams a live member of the workspace is in now. */
  listJoined(
    workspaceId: string,
    userId: string,
    query: PaginationQuery,
  ): Promise<TeamPage<Pick<Team, "id" | "name">>>;
}
