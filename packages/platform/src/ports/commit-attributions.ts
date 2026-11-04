import type { AttributionExpectation } from "@werft-ai/runtime-core";

/**
 * What each claim of a session asked its commits to carry. A push is checked
 * against all of a session's bundles (any one passes a commit), so the values
 * the server issued, not what a worker reports, decide.
 */
export interface CommitAttributionLedger {
  /** Idempotent: the same bundle twice is one row. */
  record(sessionId: string, expectation: AttributionExpectation): Promise<void>;
  list(sessionId: string): Promise<AttributionExpectation[]>;
}
