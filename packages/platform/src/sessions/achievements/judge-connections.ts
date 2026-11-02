import type { EgressUpstream } from "../catalog.ts";

/**
 * Where a workspace judge setting's `connection_id` leads: the Decisions API
 * upstream with the connection's credential, for the egress proxy to attach.
 * Null when the connection does not exist, is disabled, or is not of kind
 * `openai_decisions`; the judgment is then skipped (`judge_unavailable`).
 */
export interface JudgeConnections {
  upstream(connectionId: string): Promise<EgressUpstream | null>;
}

/** Until connections are stored, no connection resolves. */
export const NO_JUDGE_CONNECTIONS: JudgeConnections = {
  upstream: async () => null,
};
