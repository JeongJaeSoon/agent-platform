import type {
  AgentPullRequestSettings,
  PullRequestSettings,
  ReceiptActor,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

/** The workspace's pull request layout and the revision that guards it. */
export type PullRequestSettingsRead = {
  settings: PullRequestSettings;
  /** 0 until first saved. */
  revision: number;
};

export type PutPullRequestSettingsResult =
  | {
      outcome: "stored";
      settings: PullRequestSettings;
      revision: number;
      /** Null when the values already held and nothing was written. */
      receiptId: string | null;
    }
  | { outcome: "revision_conflict" | "actor_inactive" };

/** An agent's own pull request values and the revision that guards them. */
export type AgentPullRequestSettingsRead = {
  settings: AgentPullRequestSettings;
  /** 0 until first saved. */
  revision: number;
};

export type PutAgentPullRequestSettingsResult =
  | {
      outcome: "stored";
      settings: AgentPullRequestSettings;
      revision: number;
      /** Null when the values already held and nothing was written. */
      receiptId: string | null;
    }
  | {
      outcome:
        | "revision_conflict"
        | "actor_inactive"
        | "outranked"
        | "not_found";
    };

/**
 * `pull_request` and `pull_request_revision` on `github_workspace_settings`,
 * and the agents' rows in `agent_pull_request_settings`. Apart from the
 * ceiling's store: a save here never moves the ceiling's revision, and a row
 * that holds only these reads as no ceiling.
 */
export interface PullRequestSettingsStore {
  /** The defaults (`inherit`, nothing set) for an agent with no row. */
  agent(agentId: string): Promise<AgentPullRequestSettingsRead>;
  /**
   * The row of the agent the session ran under, read at the moment of use;
   * null when the session has no agent or the agent no row.
   */
  agentOfSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<AgentPullRequestSettings | null>;
  /**
   * CAS on `revision`, inside the agent's own change lock; writes
   * `set_agent_pull_request_settings`.
   */
  putAgent(input: {
    workspaceId: string;
    agentId: string;
    settings: AgentPullRequestSettings;
    revision: number;
    principal: Principal;
    userId: string;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<PutAgentPullRequestSettingsResult>;
  /** The defaults for a workspace with none saved, or a value this image cannot read. */
  get(workspaceId: string): Promise<PullRequestSettingsRead>;
  /** CAS on `revision`; writes `set_github_pull_request_settings`. */
  put(input: {
    workspaceId: string;
    settings: PullRequestSettings;
    revision: number;
    updatedBy: string;
    actor: ReceiptActor;
  }): Promise<PutPullRequestSettingsResult>;
}
