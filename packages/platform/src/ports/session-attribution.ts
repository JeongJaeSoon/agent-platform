import type { SessionTrigger } from "@werft-ai/contracts";

/**
 * Who a session's commits and pull requests are attributed to (design
 * github-agent.md decision 5), read now: a link made or dropped mid-session
 * shows from the next claim on.
 */
export type SessionAttributionRecord = {
  ownerId: string;
  trigger: SessionTrigger;
  agentId: string | null;
  agentReleaseId: string | null;
  /** Null when no person started it (an agent or operator key). */
  starter: {
    userId: string;
    /** Their active GitHub link, as GitHub named it at linking; else null. */
    github: { id: string; login: string } | null;
  } | null;
};

export interface SessionAttributionStore {
  attribution(sessionId: string): Promise<SessionAttributionRecord | null>;
}
