import type { SessionEvent } from "@werft-ai/contracts";

import type { NativeSdkMessage } from "./agent-run.ts";
import type { ApprovalOutcome, ApprovalRequested } from "./approval.ts";

export type TokenUsage = Readonly<Record<string, unknown>>;

export interface TurnEnded {
  /** The engine did not report a clean success. */
  isError: boolean;
  /**
   * The engine stopped mid-turn, as any abort ends it. Only a host that
   * interrupted the turn can tell it was its interrupt.
   */
  abortedByStop: boolean;
  budgetExceeded: boolean;
  /** Why the turn did not succeed; set whenever it was an error or aborted. */
  failure?: { reason: string; httpStatus?: number };
  /** Fills the public result's keys; the host carries it without reading it. */
  engineResult: Readonly<Record<string, unknown>>;
  /**
   * `deltaUsd` is what the engine spent since the last `turn.ended` that
   * reported a cost. `unknown` when this one reported none: what it spent
   * rides on the next that does. `countRestarted` latches once the engine
   * starts its count, and the budget it was given, over within this run.
   */
  cost: { deltaUsd?: number; countRestarted: boolean; unknown: boolean };
  usage?: TokenUsage;
  engineSessionId?: string;
  /** The inputs the engine says this turn consumed; empty when it names none. */
  inputs: readonly string[];
}

/**
 * For one engine message the run emits its public events, then its
 * `tool.called` events, then its `runtime.warning` or `turn.ended`, then
 * `native`. A `tool.called` therefore follows the public event carrying
 * that call, and precedes any `approval.requested` for the same
 * `toolCallId`.
 */
export type RuntimeEventBody =
  | {
      type: "public";
      event: SessionEvent;
      /**
       * The host inputs (`AgentInput.uuid`) the engine message behind this
       * event is for, as the engine names them or, when it names none, as
       * the run knows them. Absent when neither says.
       */
      inputs?: readonly string[];
    }
  | { type: "tool.called"; toolCallId: string; tool: string }
  | { type: "tool.admitted"; toolCallId: string }
  | { type: "approval.requested"; request: ApprovalRequested }
  | { type: "approval.resolved"; localId: string; outcome: ApprovalOutcome }
  | {
      type: "runtime.warning";
      kind: "api_retry" | "transcript_mirror_failed";
      detail: Record<string, unknown>;
    }
  | { type: "turn.ended"; turn: TurnEnded }
  /**
   * Transitional: the engine message itself. The host reads none of it;
   * it goes with the last engine-shaped code in the host.
   */
  | { type: "native"; message: NativeSdkMessage; inputs?: readonly string[] };

export type RuntimeEvent = RuntimeEventBody;
