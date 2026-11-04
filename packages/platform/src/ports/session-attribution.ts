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
  /**
   * The console App the session's primary repository is pinned to for
   * `author`: its bot writes the commits (decision D11). Null without a pin,
   * or when the pinned connection is gone or holds another App now.
   */
  authorApp: { slug: string; apiBase: string } | null;
  /** Whether the primary repository has an author pin at all. */
  authorPinned: boolean;
};

export interface SessionAttributionStore {
  attribution(sessionId: string): Promise<SessionAttributionRecord | null>;
}
