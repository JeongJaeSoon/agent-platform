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
  /** The attempt's running turn, read when a push request starts. */
  runningTurn(input: {
    sessionId: string;
    attemptId: string;
  }): Promise<number | null>;
  /**
   * Marks that turn while it still runs: once it completes with a
   * checkpoint, the platform queues a turn that tells the model to ask for
   * the push again (94S-1243). False when no turn was marked.
   */
  markPushContinuation(input: {
    sessionId: string;
    turnId: number;
  }): Promise<boolean>;
}
