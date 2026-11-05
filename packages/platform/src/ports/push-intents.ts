import type { PushIntent, ReceiptActor } from "@werft-ai/contracts";

export type CreatePushIntentInput = {
  ownerId: string;
  sessionId: string;
  /** The running turn the model asked in (`turns.id`). */
  turnId: number;
  attemptId: string;
  repositoryId: string;
  targetBranch: string;
  /**
   * Who asked. The runner makes the push request as this actor and holds no
   * more authority than the session's `session.read` / `session.submit`; it
   * never gains `session.approve`.
   */
  actor: ReceiptActor;
  /** `push.primary` or `push.attached`, as judged when the model asked. */
  pushClass: "push.primary" | "push.attached";
  /** `effectiveGitHubPolicy` source at that time, for the receipt. */
  policySource: string;
  /** The pull request content to open once pushed; the PR drain reads it. */
  pullRequest?: unknown;
};

export type PushIntentWrite =
  | { outcome: "created" | "existing"; intent: PushIntent }
  /** The turn is no longer running: finalize already ended it. */
  | { outcome: "turn_not_running" };

/**
 * The control-host action-broker's record of "push what this turn ends with".
 * Lock order is session row first, then intent rows, everywhere: finalize,
 * creation and the runner's transition all take them in that order, so none
 * of them can deadlock with another.
 */
export interface PushIntentStore {
  /**
   * Writes a `deferred` intent for the turn, under the session row lock and
   * only while the turn still runs. The same turn, repository and target
   * again return the same row (`existing`), whatever its status.
   */
  createDeferred(input: CreatePushIntentInput): Promise<PushIntentWrite>;
  list(ownerId: string, sessionId: string): Promise<PushIntent[]>;
}
