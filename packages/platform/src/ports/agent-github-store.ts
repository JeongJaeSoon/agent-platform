import type { Receipt } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";
import type { SessionViewer } from "./session-share-store.ts";

export type SetAgentGitHubResult =
  | { outcome: "saved"; receiptId: string | null }
  | { outcome: "not_found" | "actor_inactive" };

/** An agent's GitHub switch (`agents.github_enabled`) and its activity. */
export interface AgentGitHubStore {
  /** Null when the workspace has no such agent. */
  enabled(workspaceId: string, agentId: string): Promise<boolean | null>;
  /** Writes `set_agent_github` only when the value changes. */
  setEnabled(input: {
    workspaceId: string;
    agentId: string;
    enabled: boolean;
    principal: Principal;
  }): Promise<SetAgentGitHubResult>;
  /**
   * The latest GitHub receipts for the agent, newest first: those naming it,
   * and those of its sessions that `viewer` sees, filtered before the limit.
   */
  activity(
    workspaceId: string,
    agentId: string,
    viewer: SessionViewer,
    limit: number,
  ): Promise<Receipt[]>;
}
