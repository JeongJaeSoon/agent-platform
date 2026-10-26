import type { AgentInput } from "./agent-runtime.ts";
import type { AnswerResult, ApprovalAnswer } from "./approval.ts";
import type {
  CheckpointLeaseGrant,
  CheckpointPreparation,
} from "./checkpoint.ts";
import type { NegotiatedCapabilities } from "./descriptor.ts";
import type { RuntimeEvent } from "./events.ts";

export type CheckpointPoint = "turn_end" | "approval_wait";

export type ParkReadiness =
  | { ok: true }
  | { ok: false; reason: "tool_executing" | "not_supported" };

/**
 * Handle for one engine execution. It may serve several turns; it is not the
 * durable Turn row the platform stores. `events()` is a single-consumer
 * stream: iterating it a second time throws, so the host fans out to
 * observers instead of subscribing twice.
 */
export interface AgentRun {
  /**
   * Resolves once the engine has loaded the session it was started on — the
   * resumed transcript read, the engine initialized — without any input
   * sent. Rejects when the transcript cannot be read. A resumed worker
   * reports itself ready only after this.
   */
  ready(): Promise<NegotiatedCapabilities>;
  /**
   * The run's events. For one tool call, its `tool.called` and the public
   * events carrying it come before its `approval.requested`.
   */
  events(): AsyncIterable<RuntimeEvent>;
  send(input: AgentInput): void;
  finishInput(): void;
  /**
   * True when the engine session already holds this input uuid: in the
   * transcript the run resumed from, or sent earlier on this run. The engine
   * deduplicates such a send and never answers it. Throws when the resumed
   * transcript cannot be read — absence is only claimed when it was checked.
   */
  holdsInput(uuid: string): Promise<boolean>;
  /** Settles an `approval.requested` at most once. */
  answer(answer: ApprovalAnswer): Promise<AnswerResult>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  parkable(): ParkReadiness;
  /** Read-only: the verdict leaseCheckpoint would reach now. */
  prepareCheckpoint(point: CheckpointPoint): Promise<CheckpointPreparation>;
  /**
   * Takes the exclusive checkpoint lease when the run is quiescent, judged in
   * the same step as prepareCheckpoint. Hold it from here until the pointer
   * CAS has definitively answered, then release it.
   */
  leaseCheckpoint(point: CheckpointPoint): Promise<CheckpointLeaseGrant>;
  abort(): void;
  close(): Promise<void>;
}
