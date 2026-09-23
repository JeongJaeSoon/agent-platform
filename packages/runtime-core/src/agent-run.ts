import type { SessionEvent } from "@agent-platform/contracts";

import type { AgentInput } from "./agent-runtime.ts";
import type {
  CheckpointLeaseGrant,
  CheckpointPreparation,
} from "./checkpoint.ts";

export type NativeSdkMessage = {
  [key: string]: unknown;
  type: string;
};

export type NativeEnvelope = {
  correlation_id: string;
  message: NativeSdkMessage;
  schema_version: "sdk-envelope/v1";
  sdk_version: string;
};

export type AgentFrame = {
  envelope: NativeEnvelope;
  events: SessionEvent[];
};

/**
 * Handle for one engine execution. It may serve several turns; it is not the
 * durable Turn row the platform stores. Frames are a single-consumer stream:
 * iterating `events()` (or the run itself) a second time throws, so the host
 * fans out to observers instead of subscribing twice.
 */
export interface AgentRun extends AsyncIterable<AgentFrame> {
  abort(): void;
  close(): void;
  events(): AsyncIterable<AgentFrame>;
  finishInput(): void;
  /**
   * True when the engine session already holds this input uuid: in the
   * transcript the run resumed from, or sent earlier on this run. The engine
   * deduplicates such a send and never answers it. Throws when the resumed
   * transcript cannot be read — absence is only claimed when it was checked.
   */
  holdsInput(uuid: string): Promise<boolean>;
  /**
   * Resolves once the engine has loaded the session it was started on — the
   * resumed transcript read, the engine initialized — without any input
   * sent. Rejects when the transcript cannot be read. A resumed worker
   * reports itself ready only after this (94S-138).
   */
  ready(): Promise<void>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  /**
   * Takes the exclusive checkpoint lease when the run is quiescent, judged in
   * the same step as prepareCheckpoint. Hold it from here until the pointer
   * CAS has definitively answered, then release it.
   */
  leaseCheckpoint(): Promise<CheckpointLeaseGrant>;
  /** Read-only: the verdict leaseCheckpoint would reach now. */
  prepareCheckpoint(): Promise<CheckpointPreparation>;
  send(input: AgentInput): void;
}
