import type { AgentGitHub, ReceiptActor } from "@werft-ai/contracts";

/** What the built-in `github` MCP server is judged on, read for every exchange. */
export type GitHubMcpSessionState = {
  ownerId: string;
  agentId: string;
  releaseId: string;
  /** The release's `policy_pins.github`; null when it carries none. */
  github: AgentGitHub | null;
  /** `agents.github_enabled` now. */
  enabled: boolean;
  /**
   * The credential that created the session, with the release's agent: who
   * an MCP call acts as. Null when the session recorded none.
   */
  actor: ReceiptActor | null;
};

export interface GitHubMcpStore {
  /** Null when the session pins no agent release. */
  sessionState(sessionId: string): Promise<GitHubMcpSessionState | null>;
}
