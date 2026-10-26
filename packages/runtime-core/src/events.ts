import type { SessionEvent } from "@werft-ai/contracts";

import type { NativeSdkMessage } from "./agent-run.ts";
import type { ApprovalOutcome, ApprovalRequested } from "./approval.ts";

export type TokenUsage = Readonly<Record<string, unknown>>;

export interface TurnEnded {
  /** The public terminal_reason, as the engine reported it. */
  terminalReason: string;
  isError: boolean;
  abortedByStop: boolean;
  budgetExceeded: boolean;
  failure?: { reason: string; httpStatus?: number };
  /** Fills the public result's keys; the host carries it without reading it. */
  engineResult: Readonly<Record<string, unknown>>;
  cost: { deltaUsd?: number; countRestarted: boolean; unknown: boolean };
  usage?: TokenUsage;
  engineSessionId?: string;
  inputs: readonly string[];
}

/**
 * For one engine message the run emits its public events, then its
 * `tool.called` events, then `native`. A host may hold the public events
 * until that `native` closes the message.
 */
export type RuntimeEventBody =
  | { type: "public"; event: SessionEvent }
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
   * Transitional: the engine message itself, for the host code that still
   * reads it. `inputs` names the input it is for when the message names
   * none, as a scripted engine's do.
   */
  | { type: "native"; message: NativeSdkMessage; inputs?: readonly string[] };

export type RuntimeEvent = RuntimeEventBody;
